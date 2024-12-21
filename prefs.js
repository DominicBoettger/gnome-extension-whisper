import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class WhisperPrefsWidget extends ExtensionPreferences {
    constructor(metadata) {
        super(metadata);
    }

    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.whisper');

        const page = new Adw.PreferencesPage();
        window.add(page);

        // Group for API settings
        const apiGroup = new Adw.PreferencesGroup({
            title: 'API Settings',
        });
        page.add(apiGroup);

        // --- API Key Row ---
        const apiKeyRow = new Adw.EntryRow({
            title: 'OpenAI API Key',
            text: settings.get_string('openai-api-key'),
            hexpand: true,
        });
        // Whenever the text property changes, update GSettings
        apiKeyRow.connect('notify::text', () => {
            settings.set_string('openai-api-key', apiKeyRow.text);
        });
        apiGroup.add(apiKeyRow);

        // --- API Endpoint Row ---
        const apiEndpointRow = new Adw.EntryRow({
            title: 'API Endpoint',
            text: settings.get_string('api-endpoint') || 'https://api.openai.com/v1/',
            hexpand: true,
        });
        // Whenever the text property changes, update GSettings
        apiEndpointRow.connect('notify::text', () => {
            settings.set_string('api-endpoint', apiEndpointRow.text);
        });
        apiGroup.add(apiEndpointRow);

        // Show the window
        window.show();
    }
}
