export type Mood = 'idle' | 'typing' | 'cast' | 'watch' | 'reel' | 'lantern' | 'mend' | 'catch' | 'snap' | 'sleep'
export type View = 'side' | 'top'
export type Pond = { view: View; mood: Mood; catches: number; since: number }

declare module 'claude-code' {
  interface PluginState {
    'koi-moon-pond': { pond: Shaped<Pond> }
  }
}
