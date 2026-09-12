# Contributing

Contributions are welcome, whether that is a bug report, a question about the
data, or a pull request.

## Reporting a problem or asking a question

Open an issue at
<https://github.com/GoJian/awg_retina_tomography_ui/issues>. There is no
template; a useful report usually says what you did, what you expected, and
what happened instead. For rendering problems please include your browser and
operating system, and anything the browser console printed — WebGL behaviour
varies more between machines than the rest of the application does.

If something in the documentation is wrong or unclear, that is a bug too.

## Making a change

1. Fork the repository and branch from `main`.
2. Make the change.
3. Run the tests:

   ```bash
   npm ci                     # three is a devDependency for the headless core tests
   npm test                   # unit tests; Node >= 20 (globs are expanded by the
                              # shell; on Windows use Node 22)
   npx playwright install chromium
   npm run test:e2e           # browser tests
   ```

4. Add tests for anything you fixed or added. The data, caching and geometry
   layers and the `app/ui/` view modules (over the fake DOM in
   `test/helpers/fake-dom.js`) are unit-tested in `test/`, the DOM-free
   `core/` library in `test/core/`; behaviour that only shows up in a browser
   belongs in `test/e2e/`.
5. Open a pull request describing what changed and why.

CI runs both suites plus an asset decode on every pull request.

## Style

The project has no build step, no framework and no runtime dependency beyond
Three.js, and we would like to keep it that way — please raise an issue before
adding one. Otherwise, match the surrounding code: ES modules, the existing
banner-comment convention at the top of each file, and comments that explain
*why* rather than restate the code.

## Working with the data

The application reads a CSV manifest, so most data changes need no code. Point
the viewer at an alternative manifest with `?dataset=<url>`; the columns are
documented in the [README](README.md#data). The full-resolution source scans
live in the
[Hugging Face dataset](https://huggingface.co/datasets/kush1434/awg_retina_tomography_ui)
and are never modified by this repository.

If you regenerate the optimized assets, please include the
`tools/bench --verify` output for any mesh whose decimation settings changed, so
the accuracy claims in the README stay honest.

## Licensing

The viewer's code is MIT. The bundled reference eye models keep their upstream
licences (GPL-3.0 and CC BY 4.0) and are documented in
[`optimized/anatomy/README.md`](optimized/anatomy/README.md). By contributing you
agree that your contribution is licensed under the MIT licence.
