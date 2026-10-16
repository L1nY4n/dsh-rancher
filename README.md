# DSH Rancher

DeepSeek Harness 内嵌多 Rancher 管理插件。DSH 左侧导航中的 **Rancher** 打开独立工作台；设置 → Rancher 只管理服务器连接。主题变量和轻量导航参考 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)；业务功能独立实现。

## 功能

| 页面 | 功能 |
| --- | --- |
| 连接设置 | 多 Rancher 连接，支持 Bearer Token、账户密码、Access Key / Secret Key；新增、编辑、移除、连接测试；每个连接单独设只读或启用管理 |
| 集群 | 查询 Rancher 可访问的集群，切换集群与命名空间 |
| 命名空间 | 独立列表，状态、Rancher 项目 ID、标签、创建时间，直接打开该空间的 Pods；可搜索、多选的空间选择器 |
| 节点 | CPU/内存实际用量与占可分配资源百分比、用量排序、资源压力、系统/运行时/容量详情；封锁/解封，查看节点全部 Pods |
| Pods | CPU/内存实际用量、容器请求量、QoS、重启数；按命名空间或节点树形分组、容器详情、实时日志、上一次容器日志、按 UID 删除 |
| 工作负载 | Deployment 就绪/目标/可用副本、镜像、滚动重启、扩缩容（含缩至 0） |
| 服务 | Service 类型、Cluster IP、端口 |
| 事件 | Normal / Warning、关联资源、原因、次数、最近发生时间 |

工作台顶部依次选择 Rancher 服务器、集群和命名空间。多个服务器可有相同的集群 ID；请求、凭据和管理权限按连接 ID 隔离。切换服务器会清除上个服务器的筛选、命名空间和待执行操作。当前连接在插件本次加载期间保留，切换到其他 DSH 面板后返回仍可继续使用。

Pod 日志、详情及节点详情在右侧抽屉中打开。删除、重启、扩缩容和节点调度的确认弹窗显示 Rancher、集群及目标资源；扩缩容显示当前与目标副本数。连接新增、编辑保存及移除也必须通过确认弹窗，取消不会提交变更请求。支持手动刷新和 15 秒自动刷新、明暗主题、窄屏布局、加载/空列表/权限错误状态。自动刷新在浏览器页面隐藏时暂停。

0.2.6 支持最多同时选择 100 个命名空间，未指定时表示全部。Pod、工作负载、服务、事件和 Pod 指标按所选空间分别读取并合并，不要求用户具备集群范围的列表权限；任一空间失败会明确报错，不显示不完整的成功列表。刷新后仅移除已消失的选中空间，其他选择继续保留。Pod 可切换平铺、按命名空间或按节点树形分组，支持单组或全部折叠。组头显示匹配 Pod 总数、待关注数量及已有采样的 CPU/内存合计；筛选、排序和分页继续有效，跨页组头另标当前页数量。

0.2.7 修复 Kubernetes Pod 日志请求的内容协商。Rancher/Kubernetes 代理要求 `Accept` 使用受支持的资源媒体类型，插件现在用 `application/json` 发起日志请求，同时继续按纯文本流读取日志内容。

日志默认使用 Kubernetes `follow=true` 实时流，支持普通/初始化容器切换、末尾行数、暂停/继续、自动滚动、复制与断线手动重连；关闭抽屉、切换容器或转到详情时取消上游流。上一次容器日志和关闭实时跟随后的日志使用快照。暂停保留当前内容，继续时重连并重新读取末尾窗口。浏览器最多保留最近 10,000 行或约 1 MiB 字符缓冲，超过时提示截断；服务端超过 64 KiB 字符的单行整行省略，并按完整行脱敏，避免网络分块拆开凭据。实时流的 20 秒超时只限制连接建立，容器暂时没有新日志不会被定时断开。

交互参考 Rancher 官方 Dashboard 的 [NamespaceFilter](https://github.com/rancher/dashboard/blob/master/shell/components/nav/NamespaceFilter.vue)、[ResourceTable](https://github.com/rancher/dashboard/blob/master/shell/components/ResourceTable.vue) 和 [ContainerLogs](https://github.com/rancher/dashboard/blob/master/shell/components/Window/ContainerLogs.vue)：吸纳多空间累加选择、资源分组与数量、容器日志跟随及历史实例切换，控件和主题仍使用 DSH 原生组件。

0.2.5 增加独立的 `metrics.k8s.io/v1beta1` 查询，经 Rancher 代理读取节点和 Pod 的 CPU 核数、内存工作集、采样时间与窗口；CPU 是采样窗口内的平均使用量。节点百分比以可分配资源为基准；Pod 百分比仅在采样容器与普通容器集合一致、且对应资源上限完整配置时显示。普通容器请求/上限合计不包含初始化容器，不作为调度器的有效预留量。容器资源未完整配置、或指标未采集时显示 `—`，不伪装成 0。指标独立加载，403/404/503 不影响基础列表；失败后保留的旧采样会变淡，并显示错误及单独重试入口。

需要集群可提供 Metrics API（通常由 metrics-server 提供），并允许 `metrics.k8s.io` 中 nodes/pods 的 list 权限。底部显示采样覆盖数和最早采样时间，鼠标悬停单项用量可查看采样时间、窗口或资源上限。命名空间切换会清除旧节点筛选，从节点跳转 Pods 时自动恢复全部命名空间；集群级资源明确显示不受命名空间限制。刷新集群列表保留仍然有效的当前集群；命名空间被删除后自动恢复全部范围。

界面直接调用宿主 `@deepseek-ai/dsh-client-ui-primitives` 的 Button、Input、Checkbox、Menu、SegmentedTabs、Modal、Tag 和 StateDot；下拉选择由宿主 Button + Menu 组合，不再绘制独立控件。资源表格保留业务布局，采用紧凑的 38px 表格行、固定表头与操作列，资源列表独立滚动。支持状态筛选、列排序和每页 25/50/100 条分页，底部分页栏保持可见。顶部摘要显示健康数量、节点封锁数或 Pod 重启数。Pod 详情按基本信息、容器镜像/资源/端口、状态条件和标签分组，原始 JSON 默认折叠。

## 安装

### 从 GitHub 安装

此仓库遵循 DSH 外部 Bundle 插件格式。已安装 DSH 的用户可以直接使用 GitHub 链接安装：

```sh
dsh plugin --profile web add github:L1nY4n/dsh-rancher
```

也可以使用完整仓库地址：

```sh
dsh plugin --profile web add https://github.com/L1nY4n/dsh-rancher.git
```

安装完成后完全退出并重新打开 DSH。GitHub 安装使用仓库内已提交的 `client.js`，不需要本地构建插件。更新到最新版本：

```sh
dsh plugin --profile web update dsh-rancher
```

如果使用桌面版的 `desktop` profile，将上面命令中的 `web` 替换为 `desktop`。安装后可用下面命令确认插件已加入当前 profile：

```sh
dsh plugin --profile web ls
```

安装来源也可以固定到发布标签，例如 `github:L1nY4n/dsh-rancher#v0.2.7`，以避免自动跟随后续提交。

需要支持 `dsh.bundle.patch`、浏览器 `ModuleLoader`、`main`、`sidebar.panellist`、`settings.section`，并内置 `@deepseek-ai/dsh-client-ui-primitives` 的 DSH。浏览器端使用宿主的 `slots`、`layout` 和 UI 控件；后端使用 `webServer`、`connection` 与 `tools`。没有生产 npm 依赖，不会额外安装一套 React 或控件库。

本地打包：

```sh
cd /Users/l1ny4n/Documents/study/dsh-rancher
npm ci
npm run build
npm test
npm pack
```

得到 `dsh-rancher-0.2.6.tgz`。

桌面版：完全退出 DSH 后，使用本机已安装的 CLI 执行 `dsh plugin --profile desktop add file:/Users/l1ny4n/Documents/study/dsh-rancher/dsh-rancher-0.2.6.tgz`，再重新打开 DSH。也可使用设置 → 插件中的本地包安装入口。

升级后，请确认插件清单显示 `0.2.6`，并完全退出 DSH 后重新打开；仅刷新页面不会重载后端。升级会保留现有 Rancher 连接与认证信息，旧的证书信任配置将被忽略。

Web profile 使用 CLI：

```sh
dsh plugin --profile web add file:/Users/l1ny4n/Documents/study/dsh-rancher/dsh-rancher-0.2.6.tgz
dsh plugin --profile web ls
dsh --profile web --dump-config
dsh --profile web --no-open
```

此 Mac 上安装的 CLI 路径为 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`。若 `dsh` 不在 PATH 中，可使用这个完整路径代替命令。

包内的 `cordis.patch.yml` 会随 bundle 自动挂载。已通过插件管理器安装后，不要再手工添加相同的 `rancher` loader 条目，以免重复注册。

## 首次连接

1. 打开 DSH 设置 → Rancher → 添加连接，或从 Rancher 工作台右上角的“连接设置”进入。选择一种认证方式：
   - `Bearer Token`：填写 Rancher API Token。
   - `账户密码`：填写 Rancher 用户名和密码。插件通过 Rancher 的本地登录接口换取会话 Token；密码模式适用于 Rancher 用户登录，不会把密码发给 Kubernetes API。
   - `Access Key / Secret Key`：填写 Rancher API Key 的 Access Key 和 Secret Key。插件以 Basic Authorization 发送这两个值，适合服务账号和自动化连接。
2. 填写连接名称和 Rancher 根 URL。URL 可带反向代理前缀，例如 `https://example.com/rancher`；尾部 `/v3` 会自动去除。
3. 点击“测试连接”，查看明确的登录成功、可访问集群数量或失败原因。测试不会保存草稿；“保存连接”也会先验证，失败时保留表单并显示错误，不会覆盖已保存的配置。保存成功后在连接列表点击该行的“打开”按钮或“打开工作台”，即可查看该 Rancher 的资源。
4. 新连接默认只读；需要节点封锁、Pod 删除、Deployment 重启或扩缩容时，编辑连接并勾选“启用管理操作”。
5. 重复“添加连接”即可配置更多 Rancher。各连接可使用不同认证方式和权限；在工作台顶部的“Rancher 连接”下拉框中切换。编辑或移除一条连接不会更改其他连接。

修改服务器地址时必须重新输入当前认证方式的凭据。编辑同一地址时留空会保留现有凭据。移除连接只移除本地配置，不会删除 Rancher 中的集群。

远程服务器要求 HTTPS。0.2.4 起，插件的 Rancher 请求默认不校验服务器证书，支持自签名证书、不完整 CA 链、过期证书及地址不匹配的部署，无需读取或手动信任证书。HTTPS 仍加密传输，但不验证服务器身份。该策略只作用于插件发往 Rancher 的请求，不修改系统或 DSH 其他请求的 TLS 校验；旧连接保存的证书与指纹不再参与校验。TLS 握手中断、网络超时或认证失败仍会作为实际错误显示。

只有本机回环地址允许 HTTP，以支持本地开发。401 表示 Token/登录问题，403 表示 Rancher 或 Kubernetes RBAC 权限不足；插件会显示服务端错误，不将权限失败当成空列表。工作台显示集群和资源读取错误，连接表单显示测试与保存的验证结果。

## 对话工具

宿主提供 `tools` 时，自动注册：

| 工具 | 用途 |
| --- | --- |
| `rancher_connections` | 查询已配置连接 ID 和管理开关，不返回 Token |
| `rancher_read` | `clusters`、`namespaces`、`nodes`、`pods`、`node-metrics`、`pod-metrics`、`pod`、`logs`、`deployments`、`services`、`events` |
| `rancher_manage` | `delete-pod`、`cordon`、`uncordon`、`restart-deployment`、`scale-deployment` |

可以直接对 DSH 说：“查看生产集群不健康的 Pod，并读取 worker 容器最近 200 行日志。”工具先查询连接和真实集群 ID，再读取资源。命名空间可省略以查询所有命名空间；列表查询可用 `namespaces` 数组多选，不可同时指定 `namespace`。Pod 详情、日志、删除和 Deployment 管理必须指定单一命名空间。对话日志工具返回快照；实时跟随通过工作台提供。

管理工具描述要求模型在破坏性操作前核对用户意图及目标。后端还会校验连接管理开关，Pod 删除必须提供当前 UID，防止误删同名新实例。UI 管理操作显示目标及确认弹窗。成功返回 `accepted` 表示 API 已受理，重启、扩缩容及删除的最终结果需继续读取资源状态确认。

## 接口与权限

- Rancher 集群列表：`GET /v3/clusters`，支持 Rancher `pagination.next`。
- Kubernetes 代理：`/k8s/clusters/{clusterId}/api/v1/...` 与 `/k8s/clusters/{clusterId}/apis/apps/v1/...`，支持 Kubernetes `metadata.continue` 分页。
- 节点调度：Merge Patch `nodes/{name}` 的 `spec.unschedulable`。
- Pod 删除：`DeleteOptions`，30 秒优雅退出、UID 前置条件，不使用强制删除。
- Deployment 重启：更新 Pod template 的 `kubectl.kubernetes.io/restartedAt`。
- Deployment 扩缩容：Merge Patch `deployments/{name}/scale`。

只读通常需要 Rancher 集群可见权限，以及所选范围中 Nodes / Namespaces / Pods / Deployments / Services / Events 的 `get`、`list` 和 `pods/log` 的 `get`。管理还需要对应资源的 `patch`、`pods` 的 `delete` 及 `deployments/scale` 的 `patch`。最终以 Rancher 与集群 RBAC 为准。

本版本不提供容器终端、任意 YAML 执行、节点 drain、StatefulSet/DaemonSet 编辑或集群创建/删除。

## 数据与请求边界

配置文件：`${DSH_HOME:-~/.dsh}/rancher/connections.json`，也可在 bundle 的 `config.dataDir` 中指定目录。Token、密码、Access Key 和 Secret Key 以本地明文存储，文件权限 `0600`、新建数据目录权限 `0700`，通过临时文件和 rename 原子保存。不会写入浏览器 localStorage，也不随连接查询返回前端。

浏览器只请求同源 `/api/rancher/*`；后端逐请求复用宿主 `connection.admit` 或旧版 `requestRejection`。没有宿主连接服务的独立组合使用回环 Host 与同源校验。Token 仅由后端发送到配置的 Rancher，拒绝重定向和越界分页链接。单个上游请求 20 秒绝对超时，支持取消，单响应上限 8 MiB，最多 40 页，超限明确报错，不静默截断。

Pod 详情只返回明确选取的状态、镜像、资源与端口字段，不返回容器环境变量或 Secret 数据。日志可能包含业务敏感信息，点击日志或使用对话工具时会读取所选日志；日志中的当前 Rancher Token 和 Bearer 字段会脱敏。这不等于通用业务日志脱敏。

## 开发与验证

```sh
npm run build
npm test
npm run test:ui
npm run dev
```

`npm run dev` 在 `http://127.0.0.1:4178` 启动演示；端口被占用时选空闲端口并输出实际地址。预览构建默认读取相邻的 `../deepseek-harness` 源码中的同一套 DSH 控件和主题；其他目录请设置 `DSH_SOURCE_DIR=/绝对路径/deepseek-harness`。生产包直接调用宿主控件，无需源码。演示数据全部由 `test/fixture.js` 提供，经真实插件 API 与 HTTP 客户端调用本地模拟 Rancher，页面顶部有明确演示标识。演示不会读取真实 Rancher 配置。

`RANCHER_PREVIEW_MODE=live npm run dev` 使用本机已经保存的 Rancher 连接显示真实数据，顶部会标明真实环境。它不会把凭据打入浏览器脚本；管理操作受连接的管理开关控制，会影响真实集群。

UI 测试默认使用已安装的 Chrome；也可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定 Chromium。截图和验证结果位于 `work/screenshots/`、`work/ui-results.json`。

已安装 DSH 时，可在 `npm pack` 后运行真实宿主测试：

```sh
DSH_CLI='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' npm run test:host
```

此测试仅在项目的 `work/dsh-smoke-*` 创建隔离 profile，验证 tgz 安装、bundle 挂载、真实 DSH Web 宿主启动、设置菜单、浏览器模块、连接保存、宿主鉴权与节点回读。结果在 `work/host-results.json`，截图在 `work/screenshots/dsh-host.png`。

自动回归包含后端/插件测试、CPU/内存单位换算与缺失值、空间筛选、指标权限/缺失服务的独立失败、两台 Rancher 的凭据与管理操作隔离、自签名证书、地址不匹配、不完整 CA 链、过期证书、旧指纹配置兼容及宿主 TLS 校验隔离、测试连接无持久化副作用、验证失败不覆盖配置、真实 Cordis 注册与卸载、浏览器 ModuleLoader 适配、浏览器中的节点/Pod/日志/管理操作、无需证书信任的连接流程、只读开关、权限错误重试、桌面/手机与明暗主题，以及真实 DSH Web 宿主的独立侧边栏工作台、连接设置和两台 Rancher 切换。自动回归使用模拟服务和隔离 profile；真实环境核验只进行登录和资源读取，结果见交付目录的版本化 live-results 文件。

## 目录

```text
index.js                  Host 插件入口
cordis.patch.yml          DSH bundle 声明
src/client.js             Rancher HTTP 客户端、分页、超时
src/manager.js            查询与管理操作
src/store.js              本地连接及 Token 保存
src/api.js                同源 HTTP API 与宿主鉴权
src/tools.js              对话工具注册定义
ui/                       内嵌 React 界面及主题样式
ui/view.js                工作台与设置共享的连接选择及刷新通知
scripts/                  构建、演示、浏览器验证
test/                     后端、Cordis 和 ModuleLoader 测试
client.js                 构建产物；复用宿主 React
```

MIT License。
