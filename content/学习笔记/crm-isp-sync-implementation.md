# 预出货明细-在线转投（MES → CRM）同步实现说明

- 日期：2026-10-15
- 相关文档：接口文档《预出货明细-在线转投 MES 回调同步接口文档》、`docs/adr/0001-crm-pre-shipment-sync.md`
- 说明范围：MES 侧实现（触发、取数、报文、推送、日志）

## 1. 背景与接口

MES 工单完工后，将该工单的「预出货明细-在线转投」推送给 CRM；CRM 按合同号关联生产销售单，补全组织、工单号、单价等信息后落库。

| 项目 | 内容 |
|---|---|
| 接口地址 | 由 CRM 提供，登记在 MES `interface_registers` 表中（`id = MES2CRMOrderIspSync`） |
| 请求方式 | `POST`，`Content-Type: application/json` |
| 认证 | 无需用户认证 |
| 响应约定 | `{ code, msg, data }`；`code=200` 且 `data=true` 视为成功，`data=false` 表示未匹配到生产销售单 |

## 2. 触发时机与调用链

**工单自动完工时触发一次，且在事务提交之后推送。**

链路：

```
入库完成（半成品：入库审批 sf_instore_order；成品：WMS 回调）
  → WorkOrderInboundQuantityService#recalculate  汇总已完成数量
  → 已完成数量 ≥ 计划数量且工单为 RUNNING → 置为 FINISH（autoFinished 分支）
  → 事务提交（afterCommit）
  → MES2CRMOrderIspSync#doTran(workOrderId)
```

要点：

- 只在「`RUNNING → FINISH`」这一次状态跃迁上推送，天然满足"同一明细不重复推送"的约束（一个工单完工只发生一次）。
- 推送在**事务提交后**执行，CRM 不会读到中间态，也不占用 MES 事务连接。
- 推送异常被完整捕获：**只记日志，不影响工单完工**，**不自动重试**（避免 CRM 侧重复入库）；补偿方式为人工核对后重推。
- 总开关 `push.crm.isp.sync.switch`（系统设置项，**默认 `Y`**，上线即开启；置 `N` 可按 §6.2 关闭）。

> 注：当前挂载点是"所有入库完成后统一重算"的位置，因此**半成品入库审批**与**成品 WMS 入库回调**两条路都会走到它

## 3. 报文与字段来源

| 接口字段 | 类型 | MES 取值来源 |
|---|---|---|
| `groupPoNo` | String | 工单 `work_orders.cust_so_new_id`（来源委外订单号） |
| `lotNumber` | String | 工单 `work_orders.segment6_id`（工单批次管控 LOT） |
| `itemNumber` | String | 入库明细的产品 `products.name` |
| `productLine` | String | 工单 `work_orders.g_prod_line` |
| `productPn` | String | 该产品 `prod_model_id` 关联的 `prod_models.name` |
| `confirmedQty` | BigDecimal | 入库明细 `in_store_order_dtls.qty2`（见第 4 节粒度） |
| `shipFromWarehouseCode` | String | 明细仓位 `line_stores.name`（业务仓库ID，如 `8110`） |
| `shipFromWarehouseName` | String | `line_stores.name` + `"."` + `line_stores.description`（如 `8110.嵌入式待转投仓`） |
| `planDeliveryDate` | Date | **不上送**（接口文档 §3.1 明示 MES 可暂不返回） |

取数范围：该工单全部 `status = STORED` 的入库明细 `in_store_order_dtls`。

前置校验：

- `groupPoNo` 必填。为空时整批跳过并记 warn 日志（文档规定：报文存在空值时 CRM 整体不处理）。
- 无 STORED 入库明细时跳过并记 warn 日志。

## 4. 推送粒度

**同键的多条入库明细合并为一条报文，`confirmedQty` 取这些明细 `qty2` 之和。**

合并键：

```
groupPoNo | lotNumber | itemNumber | productLine | productPn | shipFromWarehouseCode | shipFromWarehouseName
```

即：**合同号 + 批次 + 料号 + 产品线 + 产品PN + 仓位**。

为什么用汇总而不是逐条：

- MES 侧一条入库明细对应**一箱**；而报文里**没有箱号/行号字段**。
- 若按明细逐条推送，同一工单的 N 条记录在上述 8 个字段上完全相同、仅数量不同；而 CRM 侧不做去重、直接新增，会产生 N 条无法区分的重复预出货明细。
- 汇总后，正常情况（单仓、单料号、单批次）**一个工单只推 1 条**；若同一工单跨多个仓位，则按仓位拆成多条。

数量口径与 MES 工单重算口径一致（均为 STORED 明细 `qty2` 累加），不会算多或算少。

## 5. 报文示例（示意，非真实数据）

```json
[
    {
        "groupPoNo": "<工单 cust_so_new_id>",
        "lotNumber": "<工单 segment6_id>",
        "itemNumber": "<产品料号>",
        "productLine": "<产品线>",
        "productPn": "<产品PN>",
        "confirmedQty": 1234,
        "shipFromWarehouseCode": "8110",
        "shipFromWarehouseName": "8110.嵌入式待转投仓"
    }
]
```

## 6. 配置与运维

### 6.1 接口地址登记

CRM 地址登记在 `interface_registers`，**换环境只改库、不改代码**：

| 列 | 值 |
|---|---|
| `id` | `MES2CRMOrderIspSync`（必须与代码常量一致） |
| `name` | `MES2CRMOrderIspSync` |
| `intf_type` | `upload`（小写；非该值请求会被拒绝） |
| `intf_url` | CRM 完整地址，如 `http(s)://<crm-host>/openapi/crm/order/isp/syncIspOrder` |
| `log_flag` | 建议开启（记录请求/响应报文，便于对账） |

未登记或地址为空时，推送会被跳过并记 error 日志（不影响完工）。

### 6.2 开关配置方式

推送开关读取 `settings` 表（elidom 标准系统设置，后台菜单「系统设置 / Settings」，REST 为 `/rest/settings`）。**未配置该键时默认开启（Y），上线即可推送。** 需要关闭时把 `value` 置为 `N`。

配置方式（二选一）：

- 页面方式：后台「系统设置 / Settings」菜单新增一条记录，`name = push.crm.isp.sync.switch`，`value = Y`（已存在则把 `value` 改为 `Y`）。
- SQL 方式：

```sql
-- 已存在则改值
UPDATE settings SET value = 'Y' WHERE name = 'push.crm.isp.sync.switch';
-- 不存在则插入（domain_id 按环境实际域填写）
INSERT INTO settings (domain_id, name, value, description)
SELECT domain_id, 'push.crm.isp.sync.switch', 'Y', '工单完工推送预出货明细-在线转投至CRM开关'
FROM (SELECT DISTINCT domain_id FROM settings LIMIT 1) t
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE name = 'push.crm.isp.sync.switch');
```

设置即时生效（`SettingUtil` 每次读取），无需重启；回滚将 `value` 改回 `N` 即可。

### 6.3 日志与排错

- 应用日志按关键字 **`CRM预出货同步`** 搜索，可见跳过原因、报文条数、成功/失败信息。
- 接口日志表：
  - `interface_logs`：按 `intf_id = 'MES2CRMOrderIspSync'`（存的是接口名称）过滤，看调用时间与成功标记；
  - `interface_params`：按 `intf_id = <interface_logs.id>` 取 `request_json` / `response_json`。
