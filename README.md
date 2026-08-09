# 摹莉（MELY）

摹莉是一个可以直接导入MMD工程文件并快速转换成Minecraft建筑的工具（后续可能会支持导出YSM模型，敬请期待）

> [!WARNING]
> **模型授权与版权责任**
>
> 严禁将通过泄露、盗取、破解、绕过访问限制或其他未经授权方式获得的他人非公开模型导入 MELY、进行转换或导出。对于公开发布但受版权保护的模型，“可下载”、“已购买”或“可访问”均不当然代表已获得转换、修改、导出、公开展示、再分发或商业使用的许可。
>
> 使用者在导入任何模型、动作、贴图或其他素材前，必须自行确认已取得必要权利，并遵守作者声明、配布条款、平台协议及适用法律。因未经授权地使用、转换、保存、发布、传播或商业利用相关素材而产生的投诉、索赔、损失或法律责任，由使用者自行承担；在适用法律允许的范围内，MELY 项目及其开发者不对上述行为及其后果承担责任。MELY 提供的技术能力不构成对任何第三方素材的授权。

**简体中文** | [English](docs/README.en.md) | [日本語](docs/README.ja.md)

## 普通用户使用方法

1. 从项目的 [GitHub Releases](https://github.com/ShadowLoveElysia/MELY/releases) 页面下载 Windows x64 安装包 `MELY-<版本号>-windows-x64-setup.exe`，或下载便携版 `MELY-<版本号>-windows-x64-portable.zip`。普通用户无需下载 Source code 压缩包。
2. 安装版直接运行安装程序；便携版需先完整解压，再双击 `MELY.exe`。若系统提示缺少 WebView2，请安装 Microsoft Edge WebView2 Runtime。
3. 导入 `.pmx`、`.pmd` 模型或包含模型与贴图的 ZIP 文件，根据需要再导入 `.vmd` 动作。
4. 在预览中调整动作时间、模型骨骼和生成参数，选定目标姿态后点击“锁定当前动作”。
5. 选择实体方块或 Ethereal Hologram 全息线框模式，设置目标高度、采样间距和材质方案，然后生成投影。
6. 检查 3D 预览、材料清单和分层建造指南，再按目标版本导出 `.litematic`、`.schem`、`.mcstructure` 或 `.mcfunction` 行为包。

> 已打包的安装版和便携版不需要 Node.js、Rust 或 Visual Studio Build Tools。本文后续的环境配置、快速启动、构建与开发命令面向需要从源码运行或参与开发的用户。

## 模型资源与友情链接

- [模之屋（APlayBox）](https://www.aplaybox.com/)：模型创作与分享平台。本链接仅用于方便用户查找由发布者提供的资源，不表示 MELY 对任何资源的权利状态、质量或可用范围作出保证。
- 下载或使用任何资源前，请逐项阅读并遵守资源页面、压缩包或附带文件中的模型声明、README 和配布条款，包括署名、修改、转换、导出、公开展示、再分发及商业使用等限制，同时遵守[模之屋用户使用协议](https://www.aplaybox.com/agreement)及适用法律。

MELY 是一款面向 Minecraft 建筑创作者的 MMD 模型转换与工程规划工具。

名称中的 `M` 代表 Minecraft，`ELY` 来自 ELYSIA。项目希望把 PMX、PMD 角色模型和 VMD 动作转换为可预览、可定格、可施工的 Minecraft 雕像与投影文件。

MELY 当前以 Minecraft Java Edition 1.20.1 的方块注册表为主要目标，同时提供 Java 版和基岩版导出能力。

## 主要功能

- 导入 `.pmx`、`.pmd` 模型、ZIP 模型包及配套贴图。
- 导入 `.vmd` 动作，实时播放、暂停、拖动时间轴、逐帧调整和锁定动作。
- 支持空格键播放或暂停 VMD 动作。
- 使用 GPU 实时绘制动画，锁帧和体素化时再生成 CPU 端蒙皮快照。
- 手动调整模型骨骼，并导入或导出轻量级 MELY Pose JSON。
- 实体方块体素化和 Ethereal Hologram 全息线框生成模式。
- 使用竖直末地烛与独立白色玻璃板表现稀疏的人物轮廓。
- Alpha 阈值、三角形与体素盒相交检测、薄表面保留和当前姿态采样。
- CIEDE2000 色差匹配、皮肤保护、面部特征增强、材质黑名单和主题调色板。
- 自发光材质映射、夜间预览和可调抖动强度。
- 材料清单、潜影盒与箱子规划、网页分层建造指南和工程自动分块。
- 导出 `.litematic`、`.schem`、`.mcstructure` 和 `.mcfunction` 行为包。
- 支持最高 2032 格的扩展高度工程，并提供多阶段风险确认。
- 中文、English、日本語界面。

## 环境要求

### 必需环境

当前源码版和快速启动脚本需要：

- Windows 10 或 Windows 11，64 位。
- **Node.js 20 或更高版本**。
- Node.js 安装时附带的 `npm`。
- 支持 WebGL 2 的现代浏览器，推荐 Microsoft Edge 或 Google Chrome。
- 首次安装依赖时需要访问 npm 软件包仓库。

建议使用 16 GB 或更多内存以及独立显卡。较高的目标高度、实体填充和大型高分辨率贴图会显著增加计算量。

安装 Node.js 后，可在 CMD 中确认：

```bat
node --version
npm --version
```

`node --version` 应显示 `v20` 或更高版本。

### 桌面开发模式

若要从源码编译并启动 Tauri 桌面应用，还需要：

- Rust stable MSVC 工具链及 Cargo。
- Microsoft Visual Studio Build Tools。
- Visual Studio Installer 中的“使用 C++ 的桌面开发”工作负载。
- Microsoft Edge WebView2 Runtime。

这些额外组件只用于桌面开发和打包。强制使用 Web 模式时不需要 Rust 或 Visual Studio Build Tools。

## 快速启动

在项目目录中双击：

```text
启动 MELY.bat
```

也可以直接运行：

```bat
MELY.bat
```

启动器会按以下顺序工作：

1. 查找已经打包或安装的 `MELY.exe`，找到后直接启动。
2. 若没有可用的 EXE，并且桌面开发环境完整，则自动编译并启动 Tauri 开发版。
3. 若桌面开发环境不完整，则自动切换到 Web 模式。
4. Web 模式会检查 `dist` 是否缺失或落后于源码。
5. 若依赖尚未安装，首次启动会自动执行 `npm ci`。
6. 自动执行 TypeScript 检查和 Vite 生产构建，然后启动本地服务并打开浏览器。

默认地址为：

```text
http://127.0.0.1:4173/
```

如果端口已经被占用，启动器会尝试后续可用端口，并在窗口中显示最终地址。

### 启动参数

强制使用自动构建的 Web 模式：

```bat
MELY.bat --web
```

强制重新构建 Web 应用：

```bat
MELY.bat --web --force-build
```

启动服务但不自动打开浏览器：

```bat
MELY.bat --web --no-open
```

强制启动 Tauri 桌面开发模式：

```bat
MELY.bat --dev
```

`--dev` 在缺少 Rust、Cargo 或 C++ Build Tools 时会直接报错，不会自动切换到 Web 模式。

## 自动构建说明

当前启动脚本确实支持自动构建并启动，但不同模式的含义不同：

| 模式 | 自动安装依赖 | 自动构建 | 自动启动 |
| --- | --- | --- | --- |
| `MELY.bat --web` | 首次缺失时执行 `npm ci` | 构建缺失或源码更新时执行 `build:web` | 启动本地 Web 服务并打开浏览器 |
| `MELY.bat --dev` | 否 | Tauri 和 Vite 开发构建 | 启动桌面开发窗口 |
| `MELY.bat` | 依据检测结果 | 依据选中的模式 | 优先 EXE，其次桌面开发，最后 Web |
| 已打包 `MELY.exe` | 不需要 | 不需要 | 直接启动桌面应用 |

自动启动桌面开发版不等于生成发布安装包。构建正式桌面安装包需要手动执行：

```bat
npm ci
npm run build:desktop
```

## Windows 一键打包

在已安装 Node.js 20+、Rust stable MSVC、Visual Studio 2022 C++ Build Tools 和
Windows 10/11 SDK 的电脑上，双击：

```text
构建 MELY.bat
```

英文入口为 `Build MELY.bat`。构建器会自动：

1. 检查 Node.js、Cargo/Rust、MSVC x64 链接器和完整的 Windows SDK。
2. 执行 `npm ci`、类型检查、全部测试和 Web 生产构建。
3. 使用 Tauri 生成 Windows x64 主程序和 NSIS 安装包。
4. 整理便携 ZIP、安装程序与 SHA-256 校验文件到 `release/`。

当前 `0.2.0` 版本的默认文件名为：

```text
MELY-0.2.0-windows-x64-portable.zip
MELY-0.2.0-windows-x64-setup.exe
MELY-0.2.0-windows-x64-SHA256SUMS.txt
```

已打包的便携版和安装版不需要 Node.js。

## GitHub 自动发布

项目提供两条 Windows 发布工作流：

- `.github/workflows/dev-release.yml`：当 `main` 分支接收新提交时自动测试和打包，
  然后将 `dev-latest` 标签移动到该提交，并覆盖 `MELY Development Build`
  预发布中的固定名附件。也可在 Actions 页面手动触发。
- `.github/workflows/release.yml`：当正式 GitHub Release 发布时，检出该
  Release 绑定的标签，而不是后续的 `main`。构建通过后，会将便携 ZIP、
  NSIS 安装程序和校验文件上传到同一个 Release 的 Assets。

正式版本的推荐发布顺序：

1. 同步修改 `package.json`、`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml`
   中的版本号。
2. 提交代码并创建对应标签，例如 `v0.2.0`。
3. 在 GitHub 上以该标签创建并发布正式 Release。
4. 等待 `Windows Release Assets` 工作流将附件上传完成。

工作流会强制检查标签版本与上述三处版本完全一致。如果 GitHub
仓库开启了 Immutable Releases，已发布的 Release 不允许再追加或替换附件；
要使用当前的“发布后构建”流程，需保持该功能关闭。

## 基本工作流程

1. 将包含 PMX、PMD 和贴图的模型文件或 ZIP 包拖入 MELY。
2. 根据需要导入 VMD 动作文件。
3. 播放动作，通过时间轴寻找合适瞬间，使用空格键或暂停按钮停止。
4. 点击“锁定动作”，将当前帧作为体素化和投影生成姿态。
5. 选择实体模式或全息线框模式，并设置目标高度、采样间距和材质方案。
6. 生成投影并检查 3D 预览、材料清单与分层建造指南。
7. 根据目标平台导出 Litematica、Schematic、Bedrock Structure 或命令行为包。

VMD 实时预览默认计算骨骼、Morph 和 IK，不启用高成本物理模拟，以尽可能降低动作播放和拖帧延迟。

## 高度兼容性

- 默认推荐角色高度为 320 格，为原版世界上下边界预留安装空间。
- 原版单维度总高度按 384 格处理。
- 超过 384 格后必须显式解锁扩展高度模式。
- 最高可设置为 2032 格，但目标世界必须安装对应的高度扩展数据包。
- 将超限投影载入普通世界可能造成顶部截断、游戏卡顿、模组崩溃或存档风险。

MELY 会在解锁、参数设置和最终导出阶段分别显示风险确认，但无法替代对目标存档的备份。

## 开发命令

安装锁定版本的依赖：

```bat
npm ci
```

启动带热更新的 Web 开发服务器：

```bat
npm run dev:web
```

自动构建并启动本地 Web 版本：

```bat
npm run start:web
```

启动 Tauri 桌面开发版：

```bat
npm run dev:desktop
```

执行测试：

```bat
npm test
```

执行类型检查、测试和 Web 生产构建：

```bat
npm run validate:web
```

仅构建 Web 版本：

```bat
npm run build:web
```

构建桌面发布包：

```bat
npm run build:desktop
```

## 项目结构

```text
MELY/
|-- src/                 React、Three.js、体素化与导出逻辑
|-- src/workers/         Web Worker 后台计算入口
|-- src-tauri/           Tauri 桌面外壳与打包配置
|-- scripts/             启动、验证与发布检查脚本
|-- tests/               算法、格式和 UI 合约测试
|-- docs/                设计参考与项目资料
|-- MELY.bat             Windows 智能启动器
`-- 启动 MELY.bat        中文快速启动入口
```

## 本地处理与隐私

MELY 的模型解析、动画预览、体素化和文件导出均在本机完成。Web 快速启动器默认只监听 `127.0.0.1`，不会将服务暴露到局域网。

本地处理不代表已获得第三方素材的使用许可。请继续遵守本文开头的模型授权与版权要求；MELY 不会改变相关素材的版权、配布条款或再分发限制。

## 常见问题

### 提示找不到 Node.js

安装 Node.js 20 或更高版本，然后重新打开 CMD 或重新双击启动脚本。若仍有问题，运行 `where node.exe` 检查系统是否能找到 Node.js。

### 为什么启动了浏览器而不是桌面窗口

自动模式在缺少 Rust、Cargo、Tauri 依赖或 Microsoft C++ Build Tools 时会回退到 Web 模式。这不影响核心转换功能。

### 为什么第一次启动较慢

首次 Web 启动可能需要下载 npm 依赖、执行 TypeScript 检查并生成 Vite 生产构建。后续启动会复用未过期的 `dist`。

### 为什么大型模型预览或生成较慢

可以降低目标高度、增大采样间距、优先使用全息线框模式，或减少高分辨率贴图。锁帧后的 CPU 蒙皮与体素化本身仍属于高密度计算。

## 许可证

本项目使用 [GNU General Public License v3.0](LICENSE)。
