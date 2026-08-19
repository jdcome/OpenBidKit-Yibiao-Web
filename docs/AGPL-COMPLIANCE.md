# AGPL-3.0 合规说明

本修改版基于 `FB208/OpenBidKit_Yibiao`，继续以 GNU Affero General Public License v3.0 only 授权。

## 必须保留

- 根目录 `LICENSE`；
- 根目录 `NOTICE`；
- 原作者 `mark / yibiaoai`；
- 原始仓库 https://github.com/FB208/OpenBidKit_Yibiao；
- 修改版说明、修改者 `jdcome` 和修改年份 2026；
- 网络用户获取当前运行修改版对应源码的显著入口。

## 网络部署

如果修改版通过 Web 网络向用户提供交互，运营者应当让这些用户免费、方便地取得正在运行版本的完整对应源码。

仅链接未修改的上游源码不能替代当前修改版源码。

默认修改版源码地址为：

https://github.com/jdcome/OpenBidKit-Yibiao-Web

可通过客户端环境变量 `VITE_SOURCE_REPOSITORY_URL` 指向实际发布当前部署版本的仓库或源码下载地址。

## 品牌资产

默认 Logo 和图标来自上游公开源码，允许管理员在运行时设置自己的系统名称和 Logo。

## 不属于对应源码的数据

API Key、JWT Secret、数据库密码、客户标书、数据库业务数据、日志和备份不应公开。

构建和运行当前版本所需的源码、schema、依赖清单和部署说明应当公开。

本文件是工程合规说明，不替代针对具体发行、商标或合同安排的法律意见。
