# MELY

> [!WARNING]
> **Model Authorization and Copyright Responsibility**
>
> Do not import into MELY, convert, or export any non-public model belonging to another person when it was obtained through a leak, theft, cracking, circumvention of access controls, or any other unauthorized means. For models that are publicly available but protected by copyright, being "downloadable," "purchased," or "accessible" does not by itself grant permission to convert, modify, export, publicly display, redistribute, or use them commercially.
>
> Before importing any model, motion, texture, or other asset, users must independently confirm that they hold all necessary rights and must comply with the creator's notices, distribution terms, platform agreements, and applicable law. Users are solely responsible for complaints, claims, losses, or legal liability arising from unauthorized use, conversion, storage, publication, distribution, or commercial exploitation of such assets. To the extent permitted by applicable law, the MELY project and its developers accept no responsibility for those actions or their consequences. MELY's technical capabilities do not grant any rights to third-party assets.

[简体中文](../README.md) | **English** | [日本語](README.ja.md)

## For End Users

1. Download the Windows x64 installer `MELY-<version>-windows-x64-setup.exe` or the portable archive `MELY-<version>-windows-x64-portable.zip` from [GitHub Releases](https://github.com/ShadowLoveElysia/MELY/releases). General users do not need the Source code archives.
2. Run the installer directly, or fully extract the portable archive and then double-click `MELY.exe`. If Windows reports that WebView2 is missing, install the Microsoft Edge WebView2 Runtime.
3. Import a `.pmx` or `.pmd` model, or a ZIP archive containing the model and its textures. Import a `.vmd` motion when needed.
4. Adjust the motion time, model bones, and generation settings in the preview. Once the desired pose is selected, choose **Lock current frame**.
5. Select solid-block mode or Ethereal Hologram wireframe mode, configure the target height, sampling interval, and material scheme, and then generate the projection.
6. Review the 3D preview, material list, and layered building guide, then export a `.litematic`, `.schem`, `.mcstructure`, or `.mcfunction` behavior pack for the target edition.

> The packaged installer and portable build do not require Node.js, Rust, or Visual Studio Build Tools. The environment setup, quick-launch, build, and development instructions later in this document are intended for users who want to run MELY from source or contribute to development.

## Model Resources and Friendly Link

- [APlayBox](https://www.aplaybox.com/) is a model creation and sharing platform. This link is provided only to help users find resources offered by their publishers; MELY makes no representation or warranty about the rights status, quality, or permitted uses of any resource.
- Before downloading or using a resource, read and follow every model notice, README, and distribution term on its page, inside its archive, or in its accompanying files. This includes restrictions concerning attribution, modification, conversion, export, public display, redistribution, and commercial use. You must also comply with the [APlayBox User Agreement](https://www.aplaybox.com/agreement) and applicable law.

MELY is an MMD model conversion and project-planning tool for Minecraft builders.

The `M` in the name stands for Minecraft, while `ELY` comes from ELYSIA. The project is designed to convert PMX and PMD character models and VMD motions into previewable, poseable, and buildable Minecraft statues and projection files.

MELY currently targets the Minecraft Java Edition 1.20.1 block registry while also providing export formats for both Java Edition and Bedrock Edition.

## Key Features

- Import `.pmx` and `.pmd` models, ZIP model packages, and their textures.
- Import `.vmd` motions with real-time playback, pause, timeline scrubbing, frame-by-frame adjustment, and pose locking.
- Play or pause VMD motions with the Space key.
- Render animation in real time on the GPU, then generate CPU-skinned snapshots only when locking a frame or voxelizing.
- Adjust model bones manually and import or export lightweight MELY Pose JSON files.
- Generate solid-block voxels or Ethereal Hologram wireframes.
- Represent sparse character contours with vertical end rods and isolated white glass panes.
- Apply alpha thresholds, triangle-box intersection tests, thin-surface preservation, and current-pose sampling.
- Use CIEDE2000 color matching, skin protection, facial-detail enhancement, material blacklists, and themed palettes.
- Map emissive materials, preview at night, and adjust dithering intensity.
- Produce material lists, shulker-box and chest plans, web-based layered building guides, and automatic project partitioning.
- Export `.litematic`, `.schem`, `.mcstructure`, and `.mcfunction` behavior packs.
- Support extended-height projects up to 2,032 blocks with multi-stage risk confirmation.
- Provide Simplified Chinese, English, and Japanese interfaces.

## System Requirements

### Required Environment

The current source build and quick-launch scripts require:

- 64-bit Windows 10 or Windows 11.
- **Node.js 20 or later**.
- The `npm` installation included with Node.js.
- A modern browser with WebGL 2 support; Microsoft Edge or Google Chrome is recommended.
- Access to the npm package registry during the first dependency installation.

At least 16 GB of memory and a dedicated GPU are recommended. Higher target heights, solid filling, and large high-resolution textures substantially increase resource use.

After installing Node.js, verify it in CMD:

```bat
node --version
npm --version
```

`node --version` should report `v20` or later.

### Desktop Development Mode

Building and starting the Tauri desktop application from source also requires:

- The Rust stable MSVC toolchain and Cargo.
- Microsoft Visual Studio Build Tools.
- The **Desktop development with C++** workload in Visual Studio Installer.
- Microsoft Edge WebView2 Runtime.

These additional components are needed only for desktop development and packaging. Rust and Visual Studio Build Tools are not required when Web mode is forced.

## Quick Launch

In the project directory, double-click:

```text
启动 MELY.bat
```

You can also run:

```bat
MELY.bat
```

The launcher works in this order:

1. Look for a packaged or installed `MELY.exe` and start it when found.
2. If no EXE is available and the desktop development environment is complete, compile and start the Tauri development build.
3. If the desktop development environment is incomplete, fall back to Web mode automatically.
4. In Web mode, check whether `dist` is missing or older than the source files.
5. If dependencies are not installed, run `npm ci` automatically on the first launch.
6. Run the TypeScript check and Vite production build, then start the local server and open the browser.

The default address is:

```text
http://127.0.0.1:4173/
```

If the port is already in use, the launcher tries subsequent available ports and displays the final address in its window.

### Launch Options

Force the automatically built Web mode:

```bat
MELY.bat --web
```

Force a fresh Web build:

```bat
MELY.bat --web --force-build
```

Start the server without opening a browser:

```bat
MELY.bat --web --no-open
```

Force Tauri desktop development mode:

```bat
MELY.bat --dev
```

When Rust, Cargo, or the C++ Build Tools are unavailable, `--dev` reports an error instead of falling back to Web mode.

## Automatic Build Behavior

The current launcher can build and start MELY automatically, but each mode behaves differently:

| Mode | Automatic dependency installation | Automatic build | Automatic start |
| --- | --- | --- | --- |
| `MELY.bat --web` | Runs `npm ci` when dependencies are missing | Runs `build:web` when the build is missing or older than the source | Starts the local Web server and opens the browser |
| `MELY.bat --dev` | No | Runs Tauri and Vite development builds | Opens the desktop development window |
| `MELY.bat` | Based on detected conditions | Based on the selected mode | Prefers an EXE, then desktop development, then Web mode |
| Packaged `MELY.exe` | Not required | Not required | Starts the desktop application directly |

Automatically starting the desktop development build does not create a release installer. To build a formal desktop package manually, run:

```bat
npm ci
npm run build:desktop
```

## One-Click Windows Packaging

On a computer with Node.js 20+, Rust stable MSVC, Visual Studio 2022 C++ Build Tools, and a Windows 10/11 SDK installed, double-click:

```text
构建 MELY.bat
```

The English entry point is `Build MELY.bat`. The build script automatically:

1. Checks Node.js, Cargo/Rust, the MSVC x64 linker, and a complete Windows SDK.
2. Runs `npm ci`, type checking, the complete test suite, and the Web production build.
3. Uses Tauri to produce the Windows x64 application and NSIS installer.
4. Places the portable ZIP, installer, and SHA-256 checksum file in `release/`.

The default filenames for version `0.2.0` are:

```text
MELY-0.2.0-windows-x64-portable.zip
MELY-0.2.0-windows-x64-setup.exe
MELY-0.2.0-windows-x64-SHA256SUMS.txt
```

The packaged portable and installed builds do not require Node.js.

## Automated GitHub Releases

The project provides two Windows release workflows:

- `.github/workflows/dev-release.yml`: whenever the `main` branch receives a new commit, this workflow tests and packages the project, moves the `dev-latest` tag to that commit, and replaces the fixed-name assets in the **MELY Development Build** prerelease. It can also be started manually from the Actions page.
- `.github/workflows/release.yml`: when a formal GitHub Release is published, this workflow checks out the tag associated with that Release rather than the later state of `main`. After a successful build, it uploads the portable ZIP, NSIS installer, and checksum file to the same Release as assets.

Recommended formal release procedure:

1. Update the version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` to the same value.
2. Commit the changes and create the corresponding tag, such as `v0.2.0`.
3. Create and publish a formal GitHub Release from that tag.
4. Wait for the **Windows Release Assets** workflow to finish uploading the assets.

The workflow requires the tag version to match all three project version fields exactly. If Immutable Releases is enabled for the GitHub repository, assets cannot be appended to or replaced in an already published Release. Keep that feature disabled to use the current post-publication build process.

## Basic Workflow

1. Drag a PMX or PMD model and its textures, or a ZIP package containing them, into MELY.
2. Import a VMD motion file when needed.
3. Play the motion, find the desired moment on the timeline, and stop it with the Space key or the pause button.
4. Select **Lock Motion** to use the current frame as the pose for voxelization and projection generation.
5. Select solid mode or hologram wireframe mode, then set the target height, sampling interval, and material scheme.
6. Generate the projection and inspect the 3D preview, material list, and layered building guide.
7. Export Litematica, Schematic, Bedrock Structure, or a command behavior pack for the target platform.

Real-time VMD preview calculates bones, morphs, and IK by default. Expensive physics simulation is disabled to minimize playback and timeline-scrubbing latency.

## Height Compatibility

- The default recommended character height is 320 blocks, leaving installation space within the vanilla world's vertical bounds.
- A vanilla dimension is treated as having a total height of 384 blocks.
- Extended-height mode must be explicitly unlocked above 384 blocks.
- The maximum target is 2,032 blocks, but the destination world must have a corresponding height-extension data pack installed.
- Loading an over-height projection into a normal world may cause top clipping, game lag, mod crashes, or save corruption.

MELY presents separate risk confirmations when unlocking the mode, configuring its parameters, and performing the final export, but these confirmations are not a substitute for backing up the destination world.

## Development Commands

Install the locked dependency versions:

```bat
npm ci
```

Start the Web development server with hot reload:

```bat
npm run dev:web
```

Automatically build and start the local Web version:

```bat
npm run start:web
```

Start the Tauri desktop development build:

```bat
npm run dev:desktop
```

Run the tests:

```bat
npm test
```

Run type checking, all tests, and the Web production build:

```bat
npm run validate:web
```

Build only the Web version:

```bat
npm run build:web
```

Build desktop release packages:

```bat
npm run build:desktop
```

## Project Structure

```text
MELY/
|-- src/                 React, Three.js, voxelization, and export logic
|-- src/workers/         Web Worker background-computation entry points
|-- src-tauri/           Tauri desktop shell and packaging configuration
|-- scripts/             Launch, validation, and release-check scripts
|-- tests/               Algorithm, format, and UI contract tests
|-- docs/                Design references and project documentation
|-- MELY.bat             Windows smart launcher
`-- 启动 MELY.bat        Chinese quick-launch entry point
```

## Local Processing and Privacy

MELY performs model parsing, animation preview, voxelization, and file export locally. The Web quick launcher listens only on `127.0.0.1` by default and does not expose the service to the local network.

Local processing does not grant permission to use third-party assets. Continue to follow the model authorization and copyright requirements at the beginning of this document. MELY does not alter the copyright, distribution terms, or redistribution restrictions attached to any asset.

## FAQ

### Node.js Cannot Be Found

Install Node.js 20 or later, then reopen CMD or double-click the launcher again. If the problem continues, run `where node.exe` to check whether Windows can locate Node.js.

### Why Did a Browser Open Instead of a Desktop Window?

Automatic mode falls back to Web mode when Rust, Cargo, the Tauri dependencies, or Microsoft C++ Build Tools are unavailable. This does not affect the core conversion features.

### Why Is the First Launch Slow?

The first Web launch may need to download npm dependencies, run the TypeScript check, and generate the Vite production build. Later launches reuse `dist` while it remains current.

### Why Are Large Models Slow to Preview or Generate?

Reduce the target height, increase the sampling interval, prefer hologram wireframe mode, or use fewer high-resolution textures. CPU skinning and voxelization after a frame is locked are still computation-intensive operations.

## License

This project is licensed under the [GNU General Public License v3.0](../LICENSE).
