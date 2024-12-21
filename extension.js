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
        const fileName = GLib.get_home_dir() + '/whisper-recording.wav';

        // Check if file exists and delete it
        const file = Gio.File.new_for_path(fileName);
        if (file.query_exists(null)) {
            file.delete(null);
        }

        this._filePath = fileName;

        // Build the GStreamer pipeline
        const pipelineDescription = `pulsesrc ! audioconvert ! audioresample ! audio/x-raw,channels=1,rate=16000 ! wavenc ! filesink location=${fileName}`;
        this._pipeline = Gst.parse_launch(pipelineDescription);

        if (!this._pipeline) {
            this._showNotification('Failed to create recording pipeline.');
            return;
        }

        this._pipeline.set_state(Gst.State.PLAYING);
        this._recording = true;
        this._icon.icon_name = 'microphone-sensitivity-muted-symbolic';
        this._icon.style = 'color: red;';
        this._startTime = GLib.get_monotonic_time();
        this._timerInterval = setInterval(() => {
            this._updateTimer();
        }, 1000);
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
        const ffmpegPath = GLib.find_program_in_path('ffmpeg');
        let uploadFilePath = this._filePath;

        if (ffmpegPath) {
            const m4aFileName = GLib.get_home_dir() + '/whisper-recording.m4a';

            try {
                // Construct the ffmpeg command to convert WAV to M4A
                const ffmpegProcess = new Gio.Subprocess({
                    argv: [
                        ffmpegPath,
                        '-i', this._filePath,
                        '-c:a', 'aac',
                        '-b:a', '64k',
                        '-y', // Overwrite output file if exists
                        m4aFileName,
                    ],
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                });

                ffmpegProcess.init(null);

                // Wait for the conversion to finish
                await new Promise((resolve, reject) => {
                    ffmpegProcess.communicate_utf8_async(null, null, (proc, res) => {
                        try {
                            proc.communicate_utf8_finish(res);
                            const success = proc.get_successful();
                            if (success) {
                                uploadFilePath = m4aFileName; // Set the file path to the converted file
                                resolve();
                            } else {
                                logError('ffmpeg conversion failed.');
                                reject(new Error('ffmpeg conversion failed.'));
                            }
                        } catch (e) {
                            logError('Error during ffmpeg conversion:', e);
                            reject(e);
                        }
                    });
                });
            } catch (e) {
                logError('ffmpeg process failed:', e);
            }
        } else {
            this._showNotification('ffmpeg not found, uploading WAV file.');
        }

        await this._sendToWhisperAPI(uploadFilePath);
        this._resetIcon(); // Reset the icon after processing is complete
    }

    async _sendToWhisperAPI(filePath) {
        const apiKey = this._settings.get_string('openai-api-key');

        if (!apiKey) {
            this._showNotification('No API key found');
            this._resetIcon(); // Reset the icon if there's an error
            return;
        }

        const file = Gio.File.new_for_path(filePath);
        const [success, fileBytes] = file.load_contents(null);
        if (!success) {
            this._showNotification('Failed to read the recorded file');
            this._resetIcon(); // Reset the icon if there's an error
            return;
        }

        const session = new Soup.Session();

        // Set up the multipart form data
        const multipart = new Soup.Multipart(Soup.FORM_MIME_TYPE_MULTIPART);
        multipart.append_form_file('file', filePath.endsWith('.m4a') ? 'audio.m4a' : 'audio.wav', filePath.endsWith('.m4a') ? 'audio/m4a' : 'audio/wav', GLib.Bytes.new(fileBytes));
        multipart.append_form_string('model', 'whisper-1');

        const apiurl = 'https://api.openai.com/v1/audio/transcriptions';

        const message = Soup.Message.new_from_multipart(apiurl, multipart);
        message.method = 'POST';
        message.request_headers.append('Authorization', `Bearer ${apiKey}`);

        await new Promise((resolve, reject) => {
            session.send_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const inputStream = session.send_finish(res);  // Get the GInputStream

                    // Use Gio.DataInputStream to read the response
                    const dataInputStream = new Gio.DataInputStream({
                        base_stream: inputStream,
                    });

                    const [responseText] = dataInputStream.read_until('', null);

                    console.log('Response:', responseText);
                    console.log(message.status_code);
                    if (message.status_code != 200) {
                        console.log('Error:', responseText);
                        this._showNotification('Error processing transcription');
                        this._resetIcon(); // Reset the icon if there's an error
                        reject(new Error('Error processing transcription'));
                        return;
                    }

                    const transcription = JSON.parse(responseText);

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
                    resolve();
                } catch (e) {
                    console.log('Error processing transcription:', e);
                    logError(e);
                    this._showNotification('Error processing transcription');
                    this._resetIcon(); // Reset the icon if there's an error
                    reject(e);
                }
            });
        });
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
