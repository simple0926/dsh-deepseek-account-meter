# GitHub 发布检查清单

按顺序做完即可发布；每一步都标注了"为什么"和"怎么确认"。

## 0. 发布前必须替换的占位符

仓库地址里目前统一用 `OWNER` 占位。发布前全局替换成实际 GitHub 用户名或组织名：

```bash
cd dsh-deepseek-account-meter
grep -rn "OWNER" . --include='*.md' --include='*.json' | grep -v node_modules
```

应出现的位置（共 4 个文件）：

| 文件 | 位置 |
|---|---|
| `README.md` | `git clone https://github.com/OWNER/...` |
| `README.en.md` | 同上 |
| `package.json` | `repository.url` / `homepage` / `bugs.url` |
| `docs/release-notes/v1.0.0.md` | 克隆地址与 CHANGELOG 链接 |

替换命令示例（把 `你的账号` 换成实际值）：

```bash
grep -rl "OWNER" . --include='*.md' --include='*.json' | xargs sed -i '' 's/OWNER/你的账号/g'
grep -rn "OWNER" . --include='*.md' --include='*.json'   # 应为空
```

同时确认这几项符合你的实际情况，不符就改：

- `LICENSE` 的版权行（当前是 `Copyright (c) 2026 syler lu`）
- `package.json` 的 `author`（当前是 `syler lu`）与 `license`（默认 MIT）
- 若要用别的许可证：换掉 `LICENSE` 全文、`package.json` 的 `license`、README 徽章文字与许可证章节

## 1. 本地自检

```bash
cd dsh-deepseek-account-meter
node --check index.js && node --check client.js
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && echo manifest OK
# 插件在本机仍可用（装上之后才有）
curl -s http://127.0.0.1:49325/dsh-deepseek-account-meter/summary | head -c 200
```

确认工作区干净、没有把 `dist/`、`release/`、`node_modules/` 带进仓库（`.gitignore` 已覆盖）。

## 2. 初始化仓库并提交

```bash
git init -b main
git add .
git status            # 确认没有 dist/ release/ node_modules/ .DS_Store
git commit -m "feat: DeepSeek balance and token usage widget for DeepSeek Harness"
git tag -a v1.0.0 -m "v1.0.0"
```

## 3. 推送到 GitHub

```bash
# 先在 GitHub 网页上建一个空仓库 dsh-deepseek-account-meter（不要勾选 README/LICENSE/gitignore）
git remote add origin git@github.com:你的账号/dsh-deepseek-account-meter.git
git push -u origin main
git push origin v1.0.0
```

## 4. 打包发布资源

在仓库**上一级**目录执行，产出一个完整压缩包 + 校验文件：

```bash
cd ..            # 回到包含 dsh-deepseek-account-meter/ 的目录
mkdir -p release
# 注意 1：在父目录执行（不要在 release/ 里用 ../ 路径），否则 zip 内会带 ../ 前缀
# 注意 2：排除模式要写窄。用 -x '*release*' 会把 docs/release-notes/ 一起排除掉
zip -qr release/dsh-deepseek-account-meter-v1.0.0.zip dsh-deepseek-account-meter \
    -x '*.DS_Store'
(cd release && shasum -a 256 dsh-deepseek-account-meter-v1.0.0.zip > SHA256SUMS)
ls -lh release
unzip -l release/dsh-deepseek-account-meter-v1.0.0.zip | head -5   # 首行应为 dsh-deepseek-account-meter/
```

想要 tar.gz 的话，把上面 `zip` 一行换成：

```bash
tar --exclude='.git' --exclude='node_modules' --exclude='release' --exclude='dist' \
    -czf release/dsh-deepseek-account-meter-v1.0.0.tar.gz dsh-deepseek-account-meter
```

确认包能独立安装：解压到一个新目录，把解压出来的目录用 `plugin_manager install_bundle` 指一次，
刷新页面能看到这一行（验证完记得卸载测试副本，避免和正式安装重复注册）。

## 5. 创建 Release

1. GitHub → Releases → **Draft a new release**
2. Tag：选已有的 `v1.0.0`（或新建同名 tag）
3. Title：`v1.0.0 — DeepSeek 余额与用量`
4. 正文：**整段复制** `docs/release-notes/v1.0.0.md` 的内容
5. 上传附件：`dsh-deepseek-account-meter-v1.0.0.zip`、`SHA256SUMS`
6. 如果没有预发布内容，取消勾选 "Set as a pre-release"；确认后 Publish

## 6. 发布后核对

- [ ] 仓库首页 README 正常渲染，中英文互链可跳转
- [ ] 徽章显示 1.0.0 / MIT / DSH 版本
- [ ] Release 页面正文完整、两个附件可下载、`shasum -a 256 -c SHA256SUMS` 通过
- [ ] 从零按 README「安装」一节走一遍能装成功（可用一个临时目录验证后卸载）
- [ ] `CHANGELOG.md` 与 Release 正文的版本号、日期一致

## 7. 可选增强

- **截图**：`docs/screenshots/composer.png` 放一张输入框下方的界面图，然后取消 `README.md` / `README.en.md`
  顶部截图占位注释的屏蔽。没有截图不影响发布。
- **npm 发布**：当前 `package.json` 是 `"private": true`、名字为 `@local/...`。要发布到 npm 需要
  改成你有权限的 scope（例如 `@你的账号/dsh-deepseek-account-meter`）并去掉 `private`；
  注意这同时会改变 `plugin_manager` 的 target 名字，需同步更新 README 的安装与卸载命令。
- **CI**：可以加一个只跑 `node --check` 的 GitHub Actions，成本极低。
