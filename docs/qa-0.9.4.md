# 0.9.4 浏览器抽样记录

日期：2026-10-16。Microsoft Edge，当前用户已配置模型；未改模型或密钥。通过 Computer Use 操作真实安装的扩展并检查截图和状态。每站只翻译阅读区域，以控制模型费用；并非整站全量兼容保证。

| 页面 | 观察结果 |
| --- | --- |
| https://openai.com/about/ | 暗色图片背景、多栏、3 段译文和 2 个生词；取消恢复 |
| https://www.anthropic.com/company | 8 段、4 个生词；图片多栏保留，发现并修复浅色背景文字对比度 |
| https://www.cloudflare.com/learning/cloud/what-is-the-cloud/ | 技术正文、侧栏和视频布局保留，4 段、4 个生词 |
| https://www.usa.gov/about | 图文及列表保留，7 段、1 个生词 |
| https://www.nasa.gov/about/ | 首次网络连接失败，刷新恢复；3 段、7 个生词，主图保留 |
| https://www.noaa.gov/about-our-agency | 4 段、8 个生词；句子联动高亮；扩展重载后需刷新旧页面 |
| https://apnews.com/science | 初次含隐私弹层；补查新闻多栏，26 个生词、37 段；可取消恢复 |
| https://www.bbc.com/news | 多栏新闻、图片和生词正常；处理中可取消；未验收全文文章翻译 |
| https://en.wikipedia.org/wiki/Artificial_intelligence | 22 个生词、7 段，引用和链接保留；测试前先关闭该页其他插件的翻译 |
| https://developer.mozilla.org/en-US/docs/Web/JavaScript | 7 个生词、6 段；内联代码保留；发现并修复根节点深色背景识别 |

本地回归覆盖：并发上限、排队取消、网络取消、401 不重试/不降级、空结果缓存、长文完整性、重复请求合并、视口采集、动态与隐藏内容、取消恢复和过期结果保护。

已知边界：模型仍可能产生生硬措辞；导航或纯链接内容以词汇标注为主；第三方插件同时翻译同一内容可能相互干扰。图片内文字、浏览器内部页面和原生 PDF 查看器不属于本版网页 DOM 支持范围。
