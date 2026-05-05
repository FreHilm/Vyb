# Third-Party Notices

Vyb uses the following open-source libraries. All dependencies use
permissive licenses (MIT, Apache-2.0, BSD-2-Clause, ISC) and are compatible
with the MIT license of this project.

## Runtime Dependencies

| Package | License | Description |
|---------|---------|-------------|
| [Electron](https://github.com/electron/electron) | MIT | Desktop application framework |
| [React](https://github.com/facebook/react) | MIT | UI component library |
| [react-dom](https://github.com/facebook/react) | MIT | React DOM renderer |
| [xterm.js](https://github.com/xtermjs/xterm.js) (@xterm/xterm) | MIT | Terminal emulator |
| [@xterm/addon-webgl](https://github.com/xtermjs/xterm.js) | MIT | WebGL-accelerated rendering |
| [@xterm/addon-fit](https://github.com/xtermjs/xterm.js) | MIT | Terminal auto-fit |
| [@xterm/addon-clipboard](https://github.com/xtermjs/xterm.js) | MIT | Clipboard integration |
| [@xterm/addon-serialize](https://github.com/xtermjs/xterm.js) | MIT | Terminal state serialization |
| [@xterm/addon-web-links](https://github.com/xtermjs/xterm.js) | MIT | Clickable URLs in terminal |
| [node-pty](https://github.com/microsoft/node-pty) | MIT | Native pseudo-terminal bindings |
| [CodeMirror](https://codemirror.net/) (codemirror, @codemirror/*) | MIT | Code editor |
| [@codemirror/theme-one-dark](https://github.com/codemirror/theme-one-dark) | MIT | Editor dark theme |
| [react-markdown](https://github.com/remarkjs/react-markdown) | MIT | Markdown renderer |
| [remark-gfm](https://github.com/remarkjs/remark-gfm) | MIT | GitHub Flavored Markdown |
| [mermaid](https://github.com/mermaid-js/mermaid) | MIT | Diagram rendering for ```mermaid``` code blocks in the README viewer |
| [archiver](https://github.com/archiverjs/node-archiver) | MIT | ZIP archive creation |
| [adm-zip](https://github.com/cthackers/adm-zip) | MIT | ZIP archive extraction |
| [electron-squirrel-startup](https://github.com/mongodb-js/electron-squirrel-startup) | Apache-2.0 | Windows installer integration |
| [@frehilm/ordna-core](https://github.com/FreHilm/ordna) | MIT | Git-native task data layer for Kanban integration |
| [@frehilm/ordna-web](https://github.com/FreHilm/ordna) | MIT | Embedded Hono+React Kanban server (web mode) |
| [@frehilm/ordna-cli](https://github.com/FreHilm/ordna) | MIT | Embedded Ordna TUI — installed into an isolated `vendor/ordna-cli/` tree so its Ink + React 18 stay separate from the app's React 19 |

## Dev Dependencies

| Package | License | Description |
|---------|---------|-------------|
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 | Type-checked JavaScript |
| [Vite](https://github.com/vitejs/vite) | MIT | Build tool |
| [Electron Forge](https://github.com/electron/forge) (@electron-forge/*) | MIT | Electron packaging and distribution |
| [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | MIT | React support for Vite |
| [ESLint](https://github.com/eslint/eslint) | MIT | Linter |
| [@typescript-eslint/parser](https://github.com/typescript-eslint/typescript-eslint) | BSD-2-Clause | TypeScript ESLint parser |
| [terser](https://github.com/terser/terser) | BSD-2-Clause | JavaScript minifier (needed for xterm.js compatibility) |
| [@typescript-eslint/eslint-plugin](https://github.com/typescript-eslint/typescript-eslint) | MIT | TypeScript ESLint rules |
| [eslint-plugin-import](https://github.com/import-js/eslint-plugin-import) | MIT | Import/export linting |

## License Texts

### MIT License

Most dependencies use the MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.

### Apache License 2.0

TypeScript and electron-squirrel-startup use the Apache License 2.0.
Full text: https://www.apache.org/licenses/LICENSE-2.0

### BSD-2-Clause License

@typescript-eslint/parser uses the BSD-2-Clause License.
Full text: https://opensource.org/licenses/BSD-2-Clause
