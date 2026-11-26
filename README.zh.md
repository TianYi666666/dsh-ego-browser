# dsh-ego-browser

[English](README.md) | 中文

把 DeepSeek Harness 的 agent 接到本机已安装的 **ego lite** 浏览器上：它用的就是你平时那个浏览器配置，
已登录的网站不需要再登一次。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `ego_browser_run` | 在浏览器里执行完整的 ego-browser Node 脚本：任务空间、`page.goto`、`page.snapshot`、`page.click`、`page.fill`、`page.screenshot`、`page.evaluate`、`page.fetch`、下载、上传。输出以文本返回，并把 `KEY=value` 行解析成结构化字段。 |
| `ego_browser_open` | 在任务空间里打开一个网址，返回标题、可见正文和无障碍快照。 |
| `ego_browser_spaces` | 列出当前任务空间的 id、名称和归属，便于后续复用而不是重开。 |
| `ego_browser_guide` | 打印与当前安装版本匹配的 CLI 用法指南 —— 写脚本时可调用哪些 TaskSpace / Page 方法，以它为准。 |

## 前置条件

- **已安装并正在运行 ego lite**（[lite.ego.app](https://lite.ego.app/)）。插件通过 `ego-browser` CLI
  驱动真实的浏览器，不会另起一个。
- **CLI 版本要与正在运行的浏览器一致**。ego lite 每个版本各带一份 CLI，版本不一致的 CLI 连不上正在运行的浏览器。
  插件会从 `mojo.CitroLabs.ego.<version>` 管道读出正在运行的版本，优先用它，其次用最新安装的那份，最后回退到
  `PATH` 上的 `ego-browser`。
- **ego lite 以提权运行或被沙箱挡住时需要完整访问权限**。ego-browser 要走中等完整性中继；低完整性沙箱下可能报
  `medium-integrity relay failed` 或 `Failed to connect to ego_cli bootstrap`，此时用完整访问权限重跑。

## 安装

```sh
dsh plugin --profile <profile> add dsh-ego-browser
```

或在桌面客户端的 **插件 → 添加插件** 里选这个目录。插件在列表里显示为 **Ego 浏览器桥接**，
可以像其他插件一样随时关闭；关闭后四个工具一起消失，不会对浏览器做任何改动。

## 配置项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `cliPath` | 自动 | `ego-browser` 可执行文件的绝对路径；环境变量 `EGO_BROWSER_CLI` 同样生效。 |
| `timeoutMs` | `120000` | 单个脚本的默认超时。 |
| `maxOutputChars` | `20000` | 返回给模型的输出上限。 |

## 用法

直接用自然语言说需求即可，例如「打开我的订单页看看状态」，agent 会自己选工具。
`ego_browser_run` 的脚本长这样：

```js
const task = await taskSpace('查发票')
const page = task.page('p1')
await page.goto('https://example.com/orders', { timeout: 45000 })
console.log('TITLE=' + (await page.title()))
console.log(await page.snapshot())
await task.finish({ keep: [] })
```

一个目标用一个任务空间；除非要留标签页给用户看，脚本结尾都该 `await task.finish({ keep: [] })`。
其余 API（选择器、ref、截图、下载、对话框处理、CDP）用 `ego_browser_guide` 查。

## 说明与限制

- 脚本走 stdin 传入，多行和非 ASCII 内容在任何 shell 下都不会被破坏。
- 只有 bootstrap / 中继失败才会换下一个候选 CLI；脚本本身跑完但报错时保留它自己的输出，错误才查得下去。
- 工具以插件自身权限运行，不会收窄 agent 在你已登录的浏览器配置里能做的事。
- Windows 与 macOS 的安装路径都会自动识别；装在别处时用 `cliPath` 指定。

## 许可

MIT
