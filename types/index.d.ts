export type Mood = 'idle' | 'typing' | 'cast' | 'watch' | 'reel' | 'lantern' | 'bait' | 'catch' | 'snap' | 'sleep'
export type View = 'side' | 'top'
export type Phase = 'night' | 'dawn' | 'day' | 'dusk'
export type TimeSetting = 'auto' | Phase
export type Pond = { view: View; mood: Mood; catches: number; since: number; time: TimeSetting; phase: Phase }

declare module 'claude-code' {
  interface PluginState {
    'koi-moon-pond': { pond: Shaped<Pond> }
  }
}
