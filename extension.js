import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gst from 'gi://Gst';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import Soup from 'gi://Soup';

const WhisperIndicator = GObject.registerClass(
class WhisperIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, 'Whisper Indicator', false);

        this._settings = settings;
        this._recording = false;
        this._pipeline = null;
        this._filePath = null;
        this._startTime = null;

        // Create a container to hold the icon and the timer label
        this._box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });

        this._icon = new St.Icon({
            icon_name: 'microphone-sensitivity-high-symbolic',
            style_class: 'system-status-icon',
        });
        this._box.add_child(this._icon);

        this._timerLabel = new St.Label({
            text: '',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._timerLabel);

        this.add_child(this._box);

        this.connect('button-press-event', () => {
            this._handleToggleRecording();
        });
    }

    async _handleToggleRecording() {
        try {
            if (this._recording) {
                await this._stopRecording();
            } else {
                this._startRecording();
            }
        } catch (e) {
            logError(e);
            this._showNotification('An error occurred during the recording process.');
        }
    }

    _startRecording() {
        // Build the GStreamer pipeline with an appsink to capture audio data in memory
        const pipelineDescription = `pulsesrc ! audioconvert ! audioresample ! audio/x-raw,channels=1,rate=16000 ! appsink name=appsink emit-signals=true`;
        this._pipeline = Gst.parse_launch(pipelineDescription);

        if (!this._pipeline) {
            this._showNotification('Failed to create recording pipeline.');
            return;
        }

        const appsink = this._pipeline.get_by_name('appsink');
        appsink.set_property('emit-signals', true);
        appsink.set_property('sync', false);
        appsink.connect('new-sample', this._onNewSample.bind(this));

        this._audioData = [];
        this._pipeline.set_state(Gst.State.PLAYING);
        this._recording = true;
        this._icon.icon_name = 'microphone-sensitivity-muted-symbolic';
        this._icon.style = 'color: red;';
        this._startTime = GLib.get_monotonic_time();
        this._timerInterval = setInterval(() => {
            this._updateTimer();
        }, 1000);
    }

    _onNewSample(appsink) {
        const sample = appsink.emit('pull-sample');
        const buffer = sample.get_buffer();
        const mapInfo = buffer.map(Gst.MapFlags.READ);

        if (mapInfo) {
            this._audioData.push(mapInfo.data);
            buffer.unmap(mapInfo);
        }

        return Gst.FlowReturn.OK;
    }

    async _stopRecording() {
        if (this._pipeline && this._recording) {
            this._pipeline.set_state(Gst.State.NULL);
            this._pipeline = null;
        }

        if (this._timerInterval) {
            clearInterval(this._timerInterval);
            this._timerInterval = null;
        }

        this._recording = false;
        this._icon.icon_name = 'microphone-sensitivity-high-symbolic';
        this._icon.style = 'color: white;';
        this._timerLabel.text = '';

        this._setInProgressIcon(); // Set the in-progress icon
        await this._processRecording();
    }

    _setInProgressIcon() {
        this._icon.icon_name = 'process-working-symbolic';
        this._icon.style = 'color: yellow;';
    }

    _resetIcon() {
        this._icon.icon_name = 'microphone-sensitivity-high-symbolic';
        this._icon.style = 'color: white;';
    }

    async _processRecording() {
        const audioBlob = new Blob(this._audioData, { type: 'audio/wav' });
        await this._sendToWhisperAPI(audioBlob);
        this._resetIcon(); // Reset the icon after processing is complete
    }

    async _sendToWhisperAPI(audioBlob) {
        const apiKey = this._settings.get_string('openai-api-key');

        if (!apiKey) {
            this._showNotification('No API key found');
            this._resetIcon(); // Reset the icon if there's an error
            return;
        }

        const formData = new FormData();
        formData.append('file', audioBlob, 'audio.wav');
        formData.append('model', 'whisper-1');

        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`
            },
            body: formData
        });

        if (!response.ok) {
            this._showNotification('Error processing transcription');
            this._resetIcon(); // Reset the icon if there's an error
            return;
        }

        const transcription = await response.json();

        // Stream the transcription at the cursor
        const seat = Clutter.get_default_backend().get_default_seat();
        const device = seat.get_pointer();
        const [x, y] = device.get_position();
        const stage = device.get_stage();
        const label = new St.Label({
            text: transcription.text,
            style_class: 'transcription-label',
        });
        label.set_position(x, y);
        stage.add_child(label);

        this._showNotification('Transcription streamed at cursor');
    }

    _updateTimer() {
        try {
            if (this._recording) {
                const elapsed = Math.floor((GLib.get_monotonic_time() - this._startTime) / 1000000);
                this._timerLabel.text = `${elapsed}s`;
            }
        } catch (e) {
            logError(e, 'Error in _updateTimer');
            this._showNotification('Error updating timer');
        }
    }


    _showNotification(text) {
        Main.notify('Whisper', text);
    }
});

let whisperIndicator = null;

export default class WhisperExtension extends Extension {
    _settings;

    enable() {
        // Initialize GStreamer
        Gst.init(null);

        this._settings = this.getSettings();
        whisperIndicator = new WhisperIndicator(this._settings); // Pass settings to WhisperIndicator
        Main.panel.addToStatusArea('whisper-indicator', whisperIndicator);
    }

    disable() {
        if (whisperIndicator) {
            // stop recording if it's in progress
            if (whisperIndicator._recording) {
                whisperIndicator._stopRecording();
            }

            // destroy the indicator
            whisperIndicator.destroy();
            whisperIndicator = null;
        }

        if(this._settings) {
            // null out the settings
            this._settings = null;
        }
    }
}
