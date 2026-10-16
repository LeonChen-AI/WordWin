# 第三方软件说明

本项目的源码许可不替代下列第三方软件的原有许可。

## PDF.js

- 来源：https://github.com/mozilla/pdf.js （官方 npm 包 `pdfjs-dist`）
- 版本：6.4.299
- 许可：Apache License 2.0，完整文本见 [vendor/pdfjs/LICENSE](vendor/pdfjs/LICENSE)。
- 打包文件：官方 `build/pdf.min.mjs`、`build/pdf.worker.min.mjs` 分别重命名为 `vendor/pdfjs/pdf.mjs`、`vendor/pdfjs/pdf.worker.mjs`，内容未修改。
- 用途：在本机解析和绘制用户选择的 PDF。

开发测试依赖列于 package.json 和 package-lock.json，依其各自许可证使用；node_modules 不包含于扩展发行包。

## Source Serif 4

随扩展打包的 Source Serif 4 字体由 Adobe 发布，采用 SIL Open Font License 1.1。许可与版权声明见 [fonts/LICENSE.md](fonts/LICENSE.md)。来源：https://github.com/adobe-fonts/source-serif 。
