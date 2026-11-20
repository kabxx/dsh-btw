# @kabxx/dsh-btw

面向 DeepSeek Harness（`0.2.2-rc.5`）的侧问插件。

- `/侧问 <问题>` 或 `/btw <question>`：基于当前对话已完成的上下文快照生成文本回答，在输入框上方展开侧问卡片；可通过卡片右上角入口移至右侧栏继续追问。
- `/侧问` 或 `/btw`：在右侧栏打开当前会话的侧问记录。「语音输入」插件就绪时，追问框可直接录音识别。

## 安装

从源码构建与打包需要 Node.js `>= 24.9.0`：

```bash
git clone https://github.com/kabxx/dsh-btw.git
cd dsh-btw
npm ci
npm run pack:local
```

在 DSH 插件管理器中选择「添加插件」，填入 `dist/kabxx-dsh-btw-0.1.0.tgz` 的绝对路径；也可在运行 `npm run build` 后直接填入仓库目录的绝对路径。

## 开发

集成测试依赖本机已安装的 DSH（`0.2.2-rc.5`）。在 DSH 外部终端运行时，需先指定安装目录（以 npm 全局安装为例）：

```bash
export DSH_INSTALL_DIR="$(npm root -g)/@deepseek-ai/dsh"
```

```bash
npm ci
npm run build
npm test
npm pack --dry-run
```

修改客户端源码或词条后，运行 `npm run build` 更新 `dist/client.js`；`npm run pack:local` 会自动完成构建并在 `dist/` 生成安装包。

## 项目结构

| 路径 | 内容 |
| --- | --- |
| [`src/host/`](src/host/) | 独立模型请求、侧问存储与远程接口 |
| [`src/client/`](src/client/) | 命令补全、侧问卡片、右侧栏与语音输入 |
| [`src/shared/`](src/shared/) | Host 与客户端共享的消息协议 |
| [`locale/`](locale/) | 中英文词条与插件元信息 |
| [`dist/`](dist/) | 客户端构建产物与本地安装包 |
| [`scripts/`](scripts/) · [`test/`](test/) | 构建脚本与回归测试 |

插件入口与加载配置见 [package.json](package.json) 和 [cordis.patch.yml](cordis.patch.yml)，第三方素材声明见 [NOTICE](NOTICE)。
