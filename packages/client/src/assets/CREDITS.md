# Galaxy Crash — Asset Credits

All assets in this project are either original, CC0, or permissively licensed.

## Visual Assets

### Rocket Sprite
- **Source**: Hand-drawn, procedurally rendered to an offscreen canvas
- **License**: MIT (project license)
- **Description**: Chrome-body rocket with red accent stripe, blue cockpit window, side fins, and an animated thrust flame (particle system)
- **Location**: `src/components/GameCanvas.tsx` — `buildRocketSprite()`

### Galaxy Background
- **Source**: Original, procedurally rendered each frame
- **License**: MIT (project license)
- **Description**: Layered parallax starfield (220 stars across 4 depth bands), four drifting nebula clouds (HSL gradients), aurora band, and faint orbital arc guides — no static image assets

### Favicon
- **Source**: Original SVG (`public/rocket.svg`)
- **License**: MIT (project license)

### Background & Grid
- **Source**: Original creation
- **License**: MIT (project license)
- **Description**: Dark blue-purple radial gradient with scrolling grid overlay, generated procedurally via Canvas API

### UI Elements
- **Source**: Original creation
- **License**: MIT (project license)
- **Description**: All UI components (bet panel, history chips, player list) are original React/Tailwind implementations

## Sound Assets

All sound effects are **procedurally synthesized at runtime** using the Web Audio
API — there are no pre-recorded sound files in the repo. Implementation lives in
`src/sounds.ts` (MIT, original):

| Sound | How it's generated |
|---|---|
| UI tick (mute button) | Short 1.2 kHz square-wave click with an exponential decay |
| Bet placed | Two-note sine arpeggio (A4 → E5) |
| Takeoff whoosh | White-noise burst through a band-pass filter sweeping 300 Hz → 3 kHz |
| Cashout chime | C-E-G-C triangle arpeggio |
| Crash boom | Decaying low-pass noise + sub-bass sine dropping 120 Hz → 40 Hz |

No external audio assets, no licensing exposure.

## Fonts

- **Inter**: [Google Fonts](https://fonts.google.com/specimen/Inter), SIL Open Font License 1.1
- **System UI fonts**: Used as fallback

## Code

- All TypeScript/React code: MIT License
- RNG algorithm: Based on public Bustabit provably-fair methodology (public domain concepts)
