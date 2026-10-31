# 隔离 UI 手动验收

在 PR #6 分支的仓库根目录运行：

```sh
scripts/preview/run.sh
```

需要 Wayland、Quickshell 和带 `shell/Ui`、`shell/Commons` 的 Omarchy。
默认使用 `${OMARCHY_PATH:-/usr/share/omarchy}`；缺失时明确报错，不安装依赖或修改系统配置。
放大检查可运行 `QT_SCALE_FACTOR=1.25 scripts/preview/run.sh`。

入口在临时目录启动独立实例，只链接实际 `BarWidget.qml`、`Panel.qml`、资源和纯 JS 库；
**不加载 Service.qml**，不运行 CLI、不读密钥文件，不发送余额/节假日请求或真实通知。
子进程移除 `DEEPSEEK_API_KEY`。宿主 UI/Commons 仍会读取现有主题和字体配置；
主题按钮只修改当前预览进程的内存配色，不写主题文件。

## 操作

屏幕顶部显示 DeepSeek 组件、Theme、State、Time 按钮，以及 `SIMULATED` 标识：

- **Theme**：循环深色/浅色预览配色；这不是完整已安装主题切换。
- **State**：循环 balance（正常余额）、loading（首次加载）、cached（刷新保留旧余额）、
  missing（无密钥）、network（网络失败）、unavailable（账号不可用）、empty（无余额条目）、
  long（长金额）、holidays（无节假日覆盖）、service（服务缺失）。
- **Time**：循环峰时、谷时、周末、切换前一秒、边界时刻。固定日期按 UTC 计算，
  本地时间按桌面时区显示；时钟不自行推进，不会发送通知。
- 状态切换按钮在面板外，点击会关闭面板；再次点击 DeepSeek 打开即可。
- 刷新只增加 `refreshes`；模拟状态不会自动变为成功。通知开关只改变显示的布尔值。
- Tooltip 内容打印到启动终端，预览未复刻宿主 tooltip 弹窗或多面板 Tab 切换。

终端会打印当前实例的 IPC 命令，例如：

```sh
quickshell ipc -p /tmp/deepseek-preview.XXXXXXXX/shell.qml call preview scenario missing
quickshell ipc -p /tmp/deepseek-preview.XXXXXXXX/shell.qml call preview theme light
```

使用本次实际打印的路径；`scenario` 会重新打开面板，`theme` 只切换配色。
不带 `-p` 可能操作其他实例，请保留它。

## 手动验收清单

1. 左键打开/再次点击关闭，点外部关闭；中键只刷新一次，不意外打开。
2. 面板打开后用 ↑/↓ 或 j/k 移动，Enter/空格激活时间轴、余额刷新和通知；
   E 展开，R 刷新，Esc 关闭。←/→ 或 h/l 滚动，鼠标滚轮可到达底部通知说明。
3. 深浅配色分别检查所有 State：数字不溢出、错误可读、无密钥不显示金额；
   cached 同时显示旧数据提示和正在更新，无覆盖年份显示 none，服务缺失显示等待。
4. Time 从切换前一秒进入边界时刻：状态栏、主倒计时和时间轴应同步变化。
   核对显示的时区；固定模拟时间不能替代真实定时器/通知验收。
5. 再以 1.25 倍缩放运行，检查文本、卡片和底部滚动区域。

在启动终端按 **Ctrl+C** 退出，只停止该预览实例并清理其临时目录；不重启生产桌面。
不要使用不带目标的 `quickshell kill`。终端被 SIGKILL/主机掉电时无法执行清理，可能残留
`/tmp/deepseek-preview.*` 目录；其中只有链接和模拟预览文件，没有密钥。

`node tests/preview.test.js` 是 CI 的纯数据检查；它验证模拟余额可被现有解析器接受，
并固定切换前后一秒的时间关系，不代表鼠标、键盘或桌面渲染验收通过。
