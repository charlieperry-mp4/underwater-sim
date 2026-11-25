# Underwater Camera Simulator

An interactive page that shows how water conditions, camera settings, subject distance and strobe lighting change an underwater photo. It runs entirely in the browser with no build step, so it works as a plain GitHub Pages site.

## What you can change

- **Water and light:** water type (clear, green, murky), suspended particles, camera depth, surface light (sun, overcast, dusk, night)
- **Subject:** distance, and an optional colour reference card
- **Camera:** lens (15mm to 100mm macro), aperture, shutter speed, ISO, white balance (daylight, custom, red filter), autofocus or manual focus distance
- **Strobe:** on/off, power, and how far it sits from the lens
- **Extras:** hold a button to see the same scene in air, histogram, exposure and clipping meters, plain-English notes on what each setting is doing, and nine presets

## What is modelled

- Red, green and blue light are absorbed at different rates, so colour disappears with depth and distance (red first)
- Scattering adds a blue-green veil, reduces contrast and softens distant objects
- Strobe light falls off with distance squared, loses colour on the way out and back, and lights suspended particles ("backscatter") depending on how close it is to the lens
- Aperture, shutter and ISO set exposure; the strobe is unaffected by shutter speed, but the ambient light is
- Depth of field, diffraction at small apertures, camera shake and subject motion blur (the strobe freezes motion, ambient light ghosts)
- ISO noise, which is amplified in the red channel when white balance boosts it

This is a teaching model on a painted reef scene, not a measurement tool. The numbers are plausible, not calibrated to a specific camera or housing.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout and controls |
| `style.css` | Styling |
| `app.js` | Wires the controls to the engine, presets, meters and notes |
| `sim.js` | The rendering engine and physics model |

## Run it locally

Open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8000
```

then visit http://localhost:8000

## Publish on GitHub Pages

1. Create a new repository on github.com (public).
2. Click **Add file > Upload files**, drag in `index.html`, `style.css`, `app.js`, `sim.js` and `README.md`, then commit.
3. Go to **Settings > Pages**, set **Source** to "Deploy from a branch", choose the `main` branch and the `/ (root)` folder, and save.
4. After a minute or two the site is live at `https://YOUR-USERNAME.github.io/REPO-NAME/`.

## Tweaking the model

All the tunable numbers are at the top of `sim.js`:

- `WATERS` holds the absorption (per metre, for red/green/blue) and scattering of each water type
- `PRESETS` defines the preset buttons
- `derive()` turns the settings into physical values (exposure constants, strobe strength, shake)
