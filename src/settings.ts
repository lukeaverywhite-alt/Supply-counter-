export type ThemePreference = 'dark'|'light'|'system'
export type UserSettings = { theme: ThemePreference; density: 'comfortable'|'compact'; motion: 'full'|'reduced'; textSize: 'standard'|'large'; defaultSection: 'count'|'inventory'|'cadets'|'activity'|'more' }
export const SETTINGS_KEY = 'argus.preferences.v1'
export const DEFAULT_SETTINGS: UserSettings = { theme: 'system', density: 'comfortable', motion: 'full', textSize: 'standard', defaultSection: 'count' }
export interface SettingsStorage { load(): UserSettings; save(value: UserSettings): void }
export class LocalSettingsStorage implements SettingsStorage {
  constructor(private storage: Pick<Storage, 'getItem'|'setItem'> = localStorage) {}
  load() { const raw = this.storage.getItem(SETTINGS_KEY); if (!raw) return { ...DEFAULT_SETTINGS }; try { return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as UserSettings } catch { return { ...DEFAULT_SETTINGS } } }
  save(value: UserSettings) { this.storage.setItem(SETTINGS_KEY, JSON.stringify(value)) }
}
