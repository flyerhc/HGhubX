# 原发布清单与当前 play 的差异核查（2026-11-15）

核查对象：用户提供的“原生 Android/iOS、磁盘缓存、进度及安全修复”完整说明。当前代码为 `play@fdbf1fd`，旧基线为 `security-audit@8b622d8`，整合提交为 `e931c47`。

**结论：这份说明不能原样作为当前 HGhubX 版本的完整功能声明。缓存和进度等已迁入，但部分原生客户端及安全机制只存在于 Git 历史，没有留在当前源码树。此前“可以提交 PR”的判断针对采用 HGhubX 后的整合范围，不等于这份更完整的清单全部达成。**

## 逐项核查

| 原清单项目 | 当前状态 | 证据或范围 |
| --- | --- | --- |
| 弱网播放体验大幅提升 | 机制已迁入，效果未量化 | 前台播放优先、缓冲储备门槛、预取和重试已保留；没有真实弱网下的跨版本量化对比，不能仅凭源码保证“大幅”提升。 |
| 旧原生 Android/iOS 客户端保留 | 未保留当前实现 | security-audit 含 29 个 native/android 文件、19 个 native/ios 文件，当前这两个目录均为 0。移动端采用 HGhubX 的 Tauri 方案。 |
| 画中画 | 部分保留 | Feed 使用浏览器 requestPictureInPicture/exitPictureInPicture；旧 Android onUserLeaveHint 自动小窗和 iOS AVPictureInPictureController 随 native 目录移除，不能声称原生后台小窗等价保留。 |
| 自动续集 | 已保留 | Feed 的 onEnded 调用下一集选择，且独立进度仅在下一集实际播放后推进；此前播放回归已验证。 |
| 换线 | 未保留原能力 | src-tauri/src/lines.rs 固定 huangguoai.com，mirrors 返回空列表，auto_pick 返回 main-fixed；api.rs 的 line_set 拒绝其他来源。接口名称仍在不等于仍可换线。 |
| iOS SIGPIPE 修复 | 历史保留，当前原实现不在 | 4530aa6、b589076 均为 play 祖先；对应 native/ios/App/Proxy.swift 已移除。新 Tauri 媒体通道没有复用原 Swift socket 代理，不能宣称相同补丁仍在现行 iOS 实现里。 |
| Minireel/HGhub 旧提交合并 | 本地已知历史已保留 | git rev-list security-audit --not play 为 0。66ebfe4、22ee681、1d76aef、4530aa6、b589076、9ca6972、a59b846 全部是 play 的祖先。无法仅据此证明本地保存了被删除仓库最后时刻的全部未知提交。 |
| 默认 256 MiB，128–4096 MiB，0 关闭/删除/清除指示 | 已保留 | media_cache、设置入口及前端调度保留；本次缓存专项核查还补齐了移动全屏指示。 |
| 两个后台槽、播放优先、HLS/Range/直接媒体、音轨/字幕缓存 | 已保留 | 存储与调度核心、全部缓存 IPC 与旧基线一致；23 项调度、9 项 Rust、4 项网络集成和 HLS/MP4 浏览器回归通过，详见磁盘缓存专项记录。 |
| 每视频独立进度、多个入口续播、旧播放器不覆盖、片尾回拖重记 | 已保留 | 独立 progress 映射、writer 与播放器生命周期接入新版 Feed/store；进度、片尾重播、存储错误、切集、画质切换已有回归。 |
| 播放接口没有地址时明确报错 | 已保留 | Feed 在没有 streamUrl 时抛出“暂无播放地址”，错误状态用于显示。 |
| 严格模式默认开启、自定义 IPv4/IPv6 CIDR、留空清除、198.18.0.0/15 | 已保留 | network_policy 默认 true，CIDR 验证/规范化/保存并用于 URL 与 DNS 地址判断；设置页可编辑。原 issue #25 描述的是用户自定义 fake-ip-range6，不能用一个固定 IPv6 网段替代配置。 |
| 账号凭据请求不跟随会重发凭据的重定向 | 已保留 | reqwest 自动重定向关闭；仅无凭据、无请求体的逻辑 GET 允许经校验的 301/302/303 重定向，业务信封仍为 POST。 |
| 登录/注销按当次会话处理，旧结果不能覆盖新登录 | 未完整实现 | Tauri 登录仅在响应后比较 base/origin，没有会话代数；注销等待服务端返回后无条件 session.clear()。旧注销晚于新登录返回时，仍可能清除新会话。旧原生端的 sessionRevision/SessionContext 未迁入此实现。 |
| Android Keystore、iOS ThisDeviceOnly Keychain | 未迁入当前 Tauri 实现 | 这些代码仍可从 security-audit 的 TokenVault.kt、Store.swift 找到，但当前 SessionStore 为明文 session.json，不是系统加密存储。 |
| 无法确认归属的旧会话重新登录，偏好历史收藏保留 | 部分保留 | Tauri 旧会话缺 origin 时不会被分配给当前站点；但没有旧独立原生应用数据迁移，应用 identifier/存储实现已变，不能承诺旧原生偏好与记录自动导入。 |
| 内网地址、DNS 答案、镜像 origin 校验 | 地址/DNS 保护保留；镜像能力变更 | 严格解析、DNS 全答案校验、地址固定与重定向检查存在，且全局代理开关不会跳过严格检查；当前已关闭镜像发现/切换，凭据仅信任固定来源。 |
| iOS 本地代理随机路径、并发和等待时间限制 | 原生机制未迁入 | 旧 Proxy.swift 使用 UUID 路径、8 个客户端、10 秒 socket 超时；当前没有该 Swift 代理。新增 Linux HTTP 通道有 32 个连接、16 KiB 请求头、30 秒超时和 Host/Origin 校验，但没有随机 capability 路径，不能混称为原 iOS 修复。 |
| Unix 桌面会话仅当前用户可读写 | 已保留 | SessionStore 设置应用数据目录 0700、会话文件 0600；仍为文件存储，不是加密。 |
| Gradle 下载按官方 SHA-256 校验 | 原显式校验未迁入现行流程 | 官方摘要校验存在于旧 native.yml/原生 wrapper 相关历史；当前用 Tauri 生成 Android 工程，仓库现行流程没有对应显式 distributionSha256Sum/下载 SHA-256 校验。不能据此说 Gradle 自身完全无完整性机制，也不能宣称原保证已保留。 |
| Actions 全部 Node.js 24；应用构建 Node.js 22 | 不完全 / Node.js 22 已保留 | release.yml:524 的 Publish job 仍使用 checkout@v4，官方 action.yml 声明 node20；其他步骤多数使用新版 Actions。各 setup-node 的应用版本仍为 22。 |
| 2026-11-11 DNS 导致 Linux 构建超时，macOS 本地正常 | 历史说明 | 这是旧构建的观察，不能证明现行云端 CI 或各平台安装包通过；本轮未重新运行云端/真机验证。 |

## 关键证据

- 旧原生实现：`git show security-audit:native/android/app/src/main/java/app/hghub/mobile/data/TokenVault.kt`、`git show security-audit:native/ios/App/Store.swift`、`git show security-audit:native/ios/App/Proxy.swift`。
- 现行会话：`src-tauri/src/api.rs` 的 api_login/api_logout，以及 `src-tauri/src/session.rs`；注销返回后直接 clear，没有与发出请求时的会话版本比较。
- 现行换线：`src-tauri/src/lines.rs` 的 mirrors/auto_pick 和 `src-tauri/src/api.rs` 的 line_set。
- [checkout v4 官方运行时声明](https://raw.githubusercontent.com/actions/checkout/v4/action.yml) 为 node20；[v7](https://raw.githubusercontent.com/actions/checkout/v7/action.yml) 为 node24。
- [原 IPv6 FakeIP issue #25](https://github.com/Minireel/HGhub/issues/25)。
- [磁盘缓存专项核实](disk-cache-integration-20261115.md)、[前次整合复核](hghubx-integration-20261114.md)。

## 需要讨论的取舍

采用 HGhubX 的现行移动实现与“完整保留旧原生 Android/iOS、原生后台小窗、Swift 代理修复”不是同一个范围。若要求这份清单全部成立，需要决定恢复并维护独立原生客户端，还是将这些能力逐项移植到 HGhubX/Tauri。后者包括移动端系统凭据存储与平台级画中画，不能只恢复几个 Rust 文件。

会话竞态保护、全部 Actions 运行时和 Gradle 显式完整性校验也仍需补齐。当前没有据此清单宣称“全部功能已经合入”，本轮只做检查和记录，没有修改应用/CI 行为或恢复原生架构。
