# DSH Rancher

在 DeepSeek Harness 中管理多个 Rancher 服务器。连接配置位于「设置 → Rancher」，资源管理使用左侧导航的「Rancher」工作台。

## 功能

- **多连接与认证**：添加、测试、编辑和切换 Rancher 连接；支持 Bearer Token、账户密码、Access Key / Secret Key，并可为每个连接单独开启管理权限。
- **集群资源**：查看集群、节点、Pods、Deployments、Services 和事件。命名空间作为统一的范围筛选，支持多选；Pod 列表按需从后端分页，搜索、排序、状态筛选与分组作用于当前页。
- **资源用量**：查看节点与 Pod 的 CPU、内存占用；指标依赖集群的 Metrics API 和相应读取权限。
- **Pod 日志**：实时跟随或查看上一次容器的日志，支持暂停、时间范围与末尾行数、文本过滤与高亮、行号、自动换行、字号调整和下载当前已加载的日志。日志抽屉可调整宽度。
- **管理操作**：封锁或解封节点、删除 Pod、重启或扩缩容 Deployment。变更操作需要确认，并受连接的管理权限限制。
- **对话工具**：向 DSH 提供 Rancher 连接查询、资源读取和管理工具。

## 安装

在已安装 DSH 的环境中运行：

```sh
dsh plugin --profile web add github:L1nY4n/dsh-rancher
```

桌面版将 `web` 换成 `desktop`。安装后完全退出并重新打开 DSH。更新插件使用：

```sh
dsh plugin --profile web update dsh-rancher
```

## 使用

在「设置 → Rancher」添加服务器地址和凭据，测试并保存连接，然后在 Rancher 工作台选择服务器和集群。新连接默认只读；需要执行管理操作时，在连接设置中开启管理权限。

插件发往 Rancher 的 HTTPS 请求**不校验服务器证书**，请只连接可信服务器。凭据保存在本机 DSH 的 Rancher 配置目录中，日志也可能包含业务敏感信息。对话工具的日志读取为快照，实时日志请在工作台查看。

## 开发

```sh
npm ci
npm run build
npm test
npm run test:ui
```

MIT License。
