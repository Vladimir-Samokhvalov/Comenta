/**
 * <script> build of the owner's settings page: defines `<comenta-settings>`.
 *
 *   <script src="settings.iife.js"></script>
 *   <comenta-settings endpoint="/api/github"></comenta-settings>
 *
 * Kept out of feedback.iife.js so visitors don't download it.
 */
import { defineSettingsElement } from './settings';

defineSettingsElement();
(window as unknown as { ComentaSettings: { defineSettingsElement: typeof defineSettingsElement } }).ComentaSettings = { defineSettingsElement };
