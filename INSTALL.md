# 安装与配置

## 安装 DSH 插件

使用 DeepSeek Harness 0.2.2，最低版本为 0.2.2-rc.5。桌面端可在「设置 → 插件管理 → 添加插件」中输入包名，或选择下载的 `.tgz` 文件。安装后重启相应的 DSH profile。

安装已公开的 npm 版本时，也可以使用 DSH CLI。

```sh
dsh plugin --profile desktop add dsh-connect-codearts
```

若命令提示桌面 profile 正在运行，先退出 DSH 桌面端。Web 用户可将 `desktop` 替换为自己的 profile 名称。DSH 安装方式见 [官方插件打包与安装文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。

安装本地发布包时，在包含包的目录执行以下命令。

```sh
dsh plugin --profile desktop add ./dsh-connect-codearts-0.1.3.tgz
```

## 配置凭据

插件按顺序读取第一组格式有效的凭据。

1. 进程环境变量 `CODEARTS_CLI_AK` 和 `CODEARTS_CLI_SK`。
2. Windows 当前用户注册表 `HKCU\Environment` 中的同名环境变量。
3. DSH 主目录中的 `.codearts-credentials.json`，包含 `accessKey` 和 `secretKey` 两个字符串字段。主目录由 `DSH_HOME` 指定，默认 `~/.dsh`。
4. 下载目录中的 `credentials.csv`、`credentials (1).csv`、`credentials (2).csv`、`访问密钥.csv`，以及 `~/.codearts/credentials.csv`。

设置页的「刷新」可重新探测凭据。如果运行中的 DSH 继承了旧环境变量，更新系统变量后重启 DSH。

## 安装独立 CLI

需要 Node.js 22.19 或更新版本。

```sh
npm install -g dsh-connect-codearts
dsh-connect-codearts doctor
```

此安装方式提供独立诊断命令。要在 DSH 的模型选择器里使用码道，请按本页第一节安装插件。
