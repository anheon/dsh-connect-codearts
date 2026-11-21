# dsh-connect-codearts

将华为云码道 CodeArts Doer 接入 DeepSeek Harness（DSH）的第三方插件。使用一组华为云 IAM AK/SK 连接码道网关，在 DSH 的模型选择器里提供 `codearts` 模型。

## 安装

在 DSH 桌面端的「设置 → 插件管理 → 添加插件」中输入 `dsh-connect-codearts`。也可以离线选择下载的 `.tgz` 文件。DSH 插件和独立 CLI 的安装步骤见 [安装指南](INSTALL.md)。

0.1.4 面向 DSH 0.2.2，最低版本为 0.2.2-rc.5。独立 CLI 需要 Node.js 22.19 或更新版本。

## 配置与使用

1. 从华为云控制台的「我的凭证 → 访问密钥」获取 AK/SK。
2. 配置 `CODEARTS_CLI_AK` 和 `CODEARTS_CLI_SK`，然后打开 DSH。其他凭据来源与读取顺序见 [安装指南](INSTALL.md)。
3. 打开「设置 → 码道 CodeArts」，检查账号状态与模型目录，然后在对话的模型选择器里选用码道模型。

支持目录刷新、模型显隐、流式回复、并行工具调用，以及向支持视觉的模型发送图片。积分余额显示在设置页和使用码道模型时的输入框旁。

自动签到默认开启。可在「设置 → 码道 CodeArts → 签到」切换开关，设置会保存在本机。关闭后仍可手动领取。签到页首次保存前，插件使用 profile 中的 `autoCheckin` 作为初始值。

## 开发与诊断

```sh
npm ci --legacy-peer-deps
npm run check
npm pack
```

独立 CLI 的 `dsh-connect-codearts doctor` 检查凭据、网关连接、模型目录和积分。问题排查与本机数据见 [FAQ](FAQ.md) 和 [隐私说明](PRIVACY.md)，实现细节见 [设计说明](DESIGN.md) 和 [协议说明](PROTOCOL.md)。

这是独立的第三方集成。码道网关接口或账号权益变更可能影响可用性。许可证为 MIT，详见 [LICENSE](LICENSE) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。
