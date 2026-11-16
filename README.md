# Koi Moon Pond

A pixel-art theme for the Claude Code desktop app: a moonlit koi pond behind your conversation, with a little fisherman on the dock who reacts to what Claude is doing.

- **Side view** (default), from dawn to night by your clock: night sky with stars, a Milky Way and the odd shooting star; a willow with an owl, a stone lantern, reeds and water lilies on the left bank; koi, swaying weed and moonbeams under the water; and a fisherman on the dock.
- **Top-down view**: koi swimming around lily pads, ripples, fireflies and the moon's reflection.
- A dark colour theme to match: deep navy panels, koi-orange accents.

The busy parts sit in the margins either side of the chat column, so the middle stays calm behind your messages. It is laid out for a maximised window.

## What the fisherman does

| When Claude Code is… | He… |
|---|---|
| sent a message | casts his line |
| working | watches the bobber |
| reading or searching | holds a lantern out over the water |
| editing files | mends his net |
| running commands or agents | reels in a fish that fights back |
| hitting an error | ends up with a slack line, scratching his head |
| done with a turn | catches a koi, which leaps into his bucket |
| idle for two minutes | dozes off |

## The rest of the pond reacts too

- **Koi**: three curious koi swim up when he casts, nibble at the bobber and blow bubbles while Claude works, dart off in all directions when he reels, and sink to rest while he sleeps. On an error, the one that got away darts off to the deep.
- **The owl** flies from the willow to the dock's lantern pole while Claude reads and hoots beside him, cocks its head while you type, flaps its wings at a catch, turns its back on an error, and keeps watch while he sleeps.
- **Wind**: the willow, reeds and seaweed whip about while he reels in a fish.
- **Water lilies** open wide while Claude edits.
- **Lights**: the stone lantern, the dock lamp and the far village pulse brighter while Claude works; the dock lamp dims while he dozes.
- **Sky and water**: a catch stirs ripples across the whole pond and brings a shooting star, a flare of moonlight and a burst of fireflies; an error draws a cloud over the moon; shooting stars come more often while he sleeps.
- **Moths** leave the dock lamp for his lantern while Claude reads.

## Day and night

The side view follows your computer's clock through four phases, redrawing only when the phase changes:

| Phase | Hours | Look |
|---|---|---|
| Dawn | 5–7 am | peach horizon, the moon setting, the last stars, lanterns half-lit |
| Day | 7 am–5 pm | hazy blue sky and sun, teal water, dragonflies, the owl asleep |
| Dusk | 5–9 pm | violet-to-orange sky, a low sun, first stars, lanterns and fireflies |
| Night | 9 pm–5 am | moon, Milky Way, shooting stars, fireflies |

The glass behind the chat is a little more solid in the brighter phases, to keep text readable. Behind the chat column, stars stay dim and still.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install koi-moon-pond --marketplace jseiden12/claude-koi-pond-theme
```

Answer `y` to add the marketplace, then press Enter to pick the scope.

From a shell:

```
claude plugin install koi-moon-pond --marketplace jseiden12/claude-koi-pond-theme
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `jseiden12/claude-koi-pond-theme`, then **Add plugin**.

Installed at the user scope, it also loads in the desktop app's Code tab sessions.

## Commands

- `/koi-view`: switch between the side view and the top-down view (`/koi-view side`, `/koi-view top`)
- `/fisherman <mood>`: show one of his reactions on demand, for example `/fisherman catch`
- `/koi-time <phase>`: hold `dawn`, `day`, `dusk` or `night`; `/koi-time auto` follows the clock again

## Notes

- The scene draws in the desktop and mobile apps; the terminal shows no backdrop.
- Each reaction redraws the scene. Reactions are spaced at least 1.5 seconds apart, and the animations pick up where they left off.
- The scene uses SVG animation (SMIL) and avoids `@media`, `shape-rendering` and viewport units, which freeze backdrop animation in current desktop builds ([anthropics/claude-code#109770](https://github.com/anthropics/claude-code/issues/109770), [#110262](https://github.com/anthropics/claude-code/issues/110262)).

## License

MIT
