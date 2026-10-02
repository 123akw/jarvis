# 高德地图 🗺️

把高德开放平台官方的远程 MCP 服务接进贾维斯：查地点、地址和坐标互转、搜周边、驾车 / 公交 / 步行 / 骑行路线、测距离、查天气。和「旅行攻略」技能搭着用，排行程时能先查路线再排。

## 它是谁家的服务

- 服务方：高德开放平台（lbs.amap.com），官方说明 <https://lbs.amap.com/api/mcp-server/summary>。
- 地址：`https://mcp.amap.com/mcp?key=${AMAP_KEY}`（Streamable HTTP，官方「快速接入」页推荐的方式）。
- **需要 Key**：管理员在「插件管理 → 高德地图 → 配置」里填 `AMAP_KEY`。申请方法：登录 lbs.amap.com 控制台 →「应用管理」创建应用 → 添加 Key，**服务平台选「Web 服务」**。Key 加密存储、不回显；没填之前插件显示「需要配置」，不能加进工具箱。
- 额度与收费：按高德开放平台对这个 Key 的配额和计费规则（控制台里能看到），服务协议见 <https://lbs.amap.com/home/terms/>。

## 能做什么

2026-10-02 本机实测：`mcp.amap.com` 可达；不带有效 Key 时返回 `INVALID_USER_KEY`，所以**没有用真 Key 跑 `tools/list`**。下面的工具名取自高德官方 npm 包 `@amap/amap-maps-mcp-server` 0.0.8 的源码（已核对）；官方文档说远程服务还多几项（生成专属地图、唤起导航、打车等），具体名字以管理员填好 Key 后贾维斯拉到的工具清单为准（会自动存档，清单变了插件会先停用等确认）。

| MCP 工具名 | 做什么 |
| --- | --- |
| `maps_geo` / `maps_regeocode` | 地址 → 经纬度 / 经纬度 → 地址 |
| `maps_ip_location` | IP 定位（注意：定位的是服务器 IP，不是用户手机） |
| `maps_weather` | 按城市查天气 |
| `maps_text_search` / `maps_around_search` / `maps_search_detail` | 关键词搜地点、周边搜索、地点详情 |
| `maps_direction_driving` / `maps_direction_transit_integrated` / `maps_direction_walking` / `maps_bicycling` | 驾车、公交、步行、骑行路线 |
| `maps_distance` | 测两点距离 |

在贾维斯里的名字是 `amap__<工具名>`，例如 `amap__maps_text_search`。

试试这样说：「从火车站开车到机场要多久」「查一下这个地址附近有没有停车场」。

## 数据会发给谁

你问的地名、地址、坐标会连同管理员的 Key 发到高德的服务器（境内）。别把家庭住址这类隐私随口说进去；高德返回的内容贾维斯只当「外部资料」参考，不当指令执行。

## 许可证

本插件包（plugin.json、mcp.json、本说明）以 MIT-0 授权，见 [../LICENSE](../LICENSE)。高德地图服务和数据归高德所有，使用时遵守高德开放平台服务协议。
