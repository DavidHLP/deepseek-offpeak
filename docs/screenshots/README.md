# Dark / Light screenshots

- `dark.png` and `light.png`: actual isolated Omarchy/Quickshell panel captures,
  showing the UI at commit `32d9ef1`, captured 2026-10-31.
- Root `preview.png`: the two original captures arranged side by side with
  Dark / Light labels. No generated or reconstructed interface elements.
- Data: `balance` fixture (45.83 CNY), fixed peak instant 2026-09-09 02:00 UTC;
  local timezone UTC-07:00. These are synthetic account readings, not live data.
- For capture only, a temporary copy of Panel.qml raised the height ceiling
  from Style.space(560) to Style.space(800) to expose the footer without a
  second scrolling image. No production UI or system configuration was changed.
- Themes: isolated process-local palette previews; not proof of acceptance with
  every installed Omarchy theme. No Service.qml or real key was loaded.

To inspect the same state: run `scripts/preview/run.sh`, select State: balance,
and switch Theme. See `scripts/preview/README.md` for input/exception acceptance.
