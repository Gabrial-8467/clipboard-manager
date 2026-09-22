import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClipboardHistoryPreferences extends ExtensionPreferences {
    getPreferencesWidget() {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'History',
            description: 'Copies are stored in ~/.local/share/clipboard-manager/history.jsonl',
        });

        const saveSwitch = new Adw.SwitchRow({
            title: 'Save history',
            subtitle: 'Record new copies to disk',
            active: settings.get_boolean('save-history'),
        });
        settings.bind('save-history', saveSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(saveSwitch);

        const maxItems = new Adw.SpinRow({
            title: 'Maximum items',
            subtitle: 'Oldest entries are dropped when the limit is reached',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 2000,
                step_increment: 10,
                value: settings.get_int('max-items'),
            }),
        });
        maxItems.connect('notify::value', () =>
            settings.set_int('max-items', maxItems.get_value()));
        group.add(maxItems);

        const preview = new Adw.SpinRow({
            title: 'Preview length',
            subtitle: 'Characters shown per entry in the menu',
            adjustment: new Gtk.Adjustment({
                lower: 20,
                upper: 1000,
                step_increment: 10,
                value: settings.get_int('preview-length'),
            }),
        });
        preview.connect('notify::value', () =>
            settings.set_int('preview-length', preview.get_value()));
        group.add(preview);

        page.add(group);
        return page;
    }
}