# 103杂入/106采购入库 收料回传 IMP-ERP「入库单过账」实现说明

- 日期：2026-10-21（2026-10-23 更新：poNumber 改为上游推送落库、receiveUserId 上送、Postman 探路通过）
- 依据文档：《204调拨出库-第三方仓库业务文档》2.6 入库单过账（json）
- 涉及仓库：后端 `plantu-xmes-longsys-server`、前端 `plantu-xmes-longsys-client`

## 1. 需求背景

103 杂入、106 采购入库两类调拨单，物料员在 MES「ERP来料批次创建」页面（cwip-tran-mat-lot）选单、扫描供应商标签、点「创建」完成收料。收料完成（整单收满）后，MES 需向 IMP-ERP 回传「入库单过账」报文，由 ERP 完成采购/杂入单的入库记账。

MES 在此流程中承担第三方仓 WMS 的角色：按接口文档规范上送 `appCode=ASN_BACK` 的过账报文。

## 2. 接口概述

| 项目 | 内容 |
|---|---|
| 方向 | MES → IMP-ERP |
| 信封固定值 | `appCode=ASN_BACK`、`busModel=ASN`、`busSystem=3rdWMS`、`wasAsync=0` |
| 请求方式 | POST，Content-Type: application/json |
| 认证 | token 请求头（复用 `MES2ERPGetToken` + settings 的 `interface.erp.appKey/appSecret`） |
| 唯一性校验键 | `asnKey + type + organizationId`（ERP 侧判重） |
| 成功判定 | 公共响应 `errorCode == 200` |
| 接口地址 | `interface_registers` 表，`id = MES2ERPAsnBack` |




## 3. 业务流程

### 3.1 页面操作流（前端）

1. **选调拨单**：选择器列出 103/104/106 三类单，选中后加载调拨单明细（行号/物料/数量/来源仓/目标仓/工单）；
2. **扫供应商标签**：`GET mat_lots/parse_qr_code` 解析 `料号#数量#LOT#产地#DC#箱号#PN[...]` 标签；卡控：标签必须在调拨单明细中、按料号累计扫描数量不超明细数量、同标签不重复扫；
3. **点「创建」**：一次性 POST `mat_lots/create_batch`。

### 3.2 收料事务（后端 `MatLotController#createBatch`）

```
createBatch（@Transactional 单事务，任一条失败整批回滚）
 ├─ 逐条 doCreate：明细匹配(标签→料号+批次+箱号兜底) → 防重(标签已收/箱号唯一) → 超量卡控 → 插入来料批次
 ├─ validateTransferFullyReceived：每条明细必须收满，任一条不满 → 整批回滚
 └─ 全部收满 → 明细+单头置 accept → MES2ERPAsnBack#pushAfterCommit(本次批次, 调拨单IDs)
```

业务规则「一个调拨单只能一次性收完」保证：**走到推送时收料必然 100% 完成，每单只会成功创建一次、推送一次**。

### 3.3 推送链路（`MES2ERPAsnBack`）

```
pushAfterCommit（注册 afterCommit，事务提交后执行，异常不影响收料）
 └─ doTran
     ├─ 开关 push.erp.asn.back.switch（缺省 Y）
     └─ 逐单调拨单 pushOneTransfer：
         ├─ 类型过滤：仅 type=103/106，其余记 info 跳过
         ├─ 组报文头 + 逐来料批次组 items（明细匹配规则与收料一致）
         ├─ 结构化必填校验（见 §5 空值策略），缺失整单跳过 + error 日志
         └─ pushData：
             ├─ interface_registers 读取地址（不存在/为空 → error 跳过）
             ├─ createRequestLog 写请求报文
             ├─ MES2ERPGetToken 换 token
             ├─ executePostCust 带 token 头 POST（超时 30s）
             ├─ 解析响应 errorCode==200 → 成功
             └─ createResponseLog 写响应报文
```

## 4. 报文字段映射

### 4.1 报文头（ASN信息）

| 接口字段 | 必填 | MES 取值 | 说明 |
|---|---|---|---|
| asnKey | Y | `mes_line_transfer.name` | 已与业务确认：103 即杂入单号、106 即采购单号，同源取调拨单号 |
| type | Y | `mes_line_transfer.type` | 103/106 |
| organizationId | Y | `mes_line_transfer.organization_id` | ERP 推单时必填落库，且有兜底校验 |
| wmsno | Y | `settings.value`（name=`interface.erp.asn.wmsno`），缺省 `ZSLS-WH` | ERP 推调拨单时未落库该字段（JOINT 入参有但未 set），故走配置 |
| wmsAsn | Y | 代码生成：`mes_line_transfer.name` + `-` + `yyyyMMddHHmmss` | WMS入库单号唯一码，每次收料生成 |
| receiveDate | Y | 代码生成：推送时刻 `yyyy-MM-dd HH:mm:ss` | |
| receiveUser | Y | `settings.value`（name=`interface.erp.asn.receiveUser`），缺省 `NETCOM_MIS` | 生产 NETCOM_MIS / DEV stephanie.ye（文档约定） |
| receiveUserId | N | 同 receiveUser（settings 配置值） | 与收货人同值上送（2026-10-21 口径） |
| accountAliases / udf1~10 | N | 不上送 | fastjson 序列化忽略 null |

### 4.2 明细行（AsnItem，每个来料批次一行）

| 接口字段 | 必填 | MES 取值 | 说明 |
|---|---|---|---|
| lineId | Y | `mes_line_out_detail.line_id` 原值（ERP 下发的行 ID，数字串如 37056483） | 非行序号；明细匹配规则与收料一致：先按 料号+标签，兜底 料号+批次+箱号 |
| wmsLineId | Y | `mat_lots.name` | 来料批次名，每次收料扫描唯一，保证行唯一 |
| poNumber | N(106传) | `mes_line_transfer.segment2_id`（ERP 推单时落库的采购单号），为空回退调拨单号 + warn | 仅 type=106 上送；PO 号来源链路见 §4.4，JSON 字段名待与上游确认 |
| workNumber | N | `work_orders.name`（经 `mes_line_out_detail.work_order_id` 关联） | 无工单不送 |
| sku | Y | `materials.name`（经 `mes_line_out_detail.prod_id` 关联） | |
| qty | Y | `mat_lots.qty_1`（转数字） | 不兜底 0：转换异常时字段不上送，由 ERP 必填校验拒收留痕 |
| subCode | Y | `mes_line_out_detail.to_store`（目标仓） | |
| lotNumber | N | `mat_lots.vendor_batch_no` | |
| ctnNo | N | `mat_lots.ctn_no` | |
| origin | Y | `mat_lots.segment2_id` | 嵌入式产品该段即 COD、模组为产地，统一取值两场景均正确；为空传空串 + warn |
| dc | N | `mat_lots.segment1_id` | |
| receiveUser | Y | 同报文头 | |

> 表与标签字段说明：
> - `mat_lots` = 来料批次表，`mes_line_out_detail` = 调拨单明细表，`mes_line_transfer` = 调拨单头表；
> - 批次的标签字段来自 `parse_qr_code`（`segment1_id`=DC、`segment2_id`=产地），与 `getMatLotInfoByBarcode`（segment1=WAFER、segment2=COA）语义不同，实现按前者取值；
> - 批次行与明细行的关联（补 lineId/仓位/工单）：先按 `mat_lots.mat_id`+`mat_lots.vendor_barcode` = `mes_line_out_detail.prod_id`+`segment4_id` 匹配，兜底按 `vendor_batch_no`=`segment2_id` 且 `ctn_no`=`segment1_id`，与收料创建（doCreate）匹配规则一致。

### 4.3 报文示例（示意，非真实数据）

```json
{
  "appCode": "ASN_BACK",
  "busModel": "ASN",
  "busSystem": "3rdWMS",
  "timestamp": "2026-10-21 15:00:00",
  "wasAsync": 0,
  "callbackUrl": "",
  "data": {
    "asnKey": "2FS50596",
    "type": "106",
    "organizationId": "190",
    "wmsno": "ZSLS-WH",
    "wmsAsn": "2FS50596-20261021150000",
    "receiveDate": "2026-10-21 15:00:00",
    "receiveUserId": "NETCOM_MIS",
    "receiveUser": "NETCOM_MIS",
    "items": [
      {
        "lineId": "37056483",
        "wmsLineId": "ML20261021001",
        "poNumber": "4500123456",
        "sku": "PNM0030004042",
        "qty": 1000,
        "subCode": "B176",
        "lotNumber": "ZS22580980",
        "ctnNo": "CTN001",
        "origin": "COD值或产地",
        "dc": "2548",
        "receiveUserId": "NETCOM_MIS",
        "receiveUser": "NETCOM_MIS"
      }
    ]
  }
}
```

### 4.4 poNumber（106 采购单号）来源链路

```
ERP 采购入库单
   │
   ▼
【源头】上游推送程序（Lucas 负责侧）构造报文时带上采购单号
   │  POST /rest/intf/erp/JOINT2MESLineTransferIn（IntfErpApiController）
   ▼
JOINT2MESLineTransferIn.doTran 落库：单头 mes_line_transfer.segment2_id = poNumber
   ├─ 新建分支：直接 set
   └─ WMS先到建桩补全分支：仅上游传了才覆盖
   │
   ▼
106 收料完成 → MES2ERPAsnBack.buildItem 取 segment2_id 作 poNumber 上送
   └─ 上游未传（segment2_id 为空）→ 回退调拨单号 + warn 日志（联调时据此发现上游未加传）
```

- 存储复用单头空闲字段 `segment2_id`（全库仅本功能读取），无需 DDL；
- 106 的明细/标签走另一条独立推送链（WMS2MESLineOutDetail），PO 号只在单头链传递；
- 103 杂入单不涉及 poNumber，segment2_id 保持为空。

## 5. 防重与空值策略

### 5.1 防重

- 收料规则「一次收完」保证每单只在收满那一次触发推送；
- ERP 按 `asnKey+type+organizationId` 判重，重复推送会被 ERP 拒绝，不会重复入账；
- 撤销收料后重新收料会再次推送 → ERP 判重拒绝 → 需人工在 ERP 侧补偿（与 MES2CRMOrderIspSync 的补偿语义一致）。

### 5.2 空值策略（原则：宁可 ERP 拒收留痕，不上送错误数据，不让边缘情况阻塞推送）

| 字段 | 异常处理 |
|---|---|
| organizationId（头） | 缺失 → 整单跳过 + error 日志 |
| lineId / wmsLineId / sku / subCode（行） | 缺失 → 整单跳过 + error 日志（属数据异常） |
| qty | 不兜底 0（防 ERP 按 0 错误过账）；转换异常时字段缺失，由 ERP 必填校验拒收留痕 |
| origin | 为空传空串 + warn 日志（业务上标签必带产地，不作为跳过条件） |

## 6. 改动文件清单

### 后端 plantu-xmes-longsys-server

| 文件 | 类型 | 说明 |
|---|---|---|
| `xyz/xmes/cintf/service/erp/asn_back/MES2ERPAsnBack.java` | 新增 | 推送服务（afterCommit、组报文、token、日志） |
| `xyz/xmes/cintf/service/erp/asn_back/MES2ERPAsnBackIn.java` | 新增 | 报文模型（信封 + Data + Item） |
| `xyz/xmes/inv/rest/MatLotController.java` | 修改 | `createBatch` 收满置 accept 后调用 `pushAfterCommit`（约 L141-143） |
| `xyz/xmes/cintf/service/erp/line_transfer_in/JOINT2MESLineTransferInIn.java` | 修改 | 单头接收字段加 `poNumber`（上游推送的采购单号，2026-10-23） |
| `xyz/xmes/cintf/service/erp/line_transfer_in/JOINT2MESLineTransferIn.java` | 修改 | `doTran` 新建/补全两分支落库单头 `segment2_id` = poNumber（补全分支仅在有值时覆盖） |

### 前端 plantu-xmes-longsys-client

| 文件 | 类型 | 说明 |
|---|---|---|
| `app/elements/cust-bundles/oi/cwip/cwip-tran-mat-lot.html` | 修改 | 调拨单选择器 `initial-params` 从 `type=104` 扩为 `type=103,104,106` |
| `app/bower_components/things-resource-selector/things-selector-form-search-behavior.html` | 补丁 | `_bindInitialParams` 多值兼容：无 `=` 的片段并入上一个参数值；已核对既有全部 initial-params 用法（每个片段均含 `=`），行为不变。**发布时勿漏此平台文件**，否则选择器退化为仅显示 103 |

## 7. 配置项

### 7.1 接口地址登记（必配，未配置则跳过推送并记 error）

`interface_registers` 插入/修改一行

| 列 | 值 |
|---|---|
| `id` | `MES2ERPAsnBack`（与代码常量一致） |
| `intf_type` | `upload`（小写，非该值请求被框架拒绝） |
| `intf_url` | IMP-ERP 入库单过账完整地址 |
| `log_flag` | 开启 |

### 7.2 settings（换环境改库不改代码，即时生效无需重启）

| name | dev 值 | 生产值 | 缺省行为 |
|---|---|---|---|
| `interface.erp.asn.receiveUser` | `stephanie.ye` | `NETCOM_MIS` | 不配为 NETCOM_MIS |
| `interface.erp.asn.wmsno` | `ZSLS-WH` | `ZSLS-WH` | 不配为 ZSLS-WH |
| `push.erp.asn.back.switch` | 不配（=Y） | 不配（=Y） | 缺省开启；临时停推送改 N |

### 7.3 token 依赖（复用现有）

- `interface_registers` 的 `MES2ERPGetToken` 行（dev 已配置）；
- `settings` 的 `interface.erp.appKey` / `interface.erp.appSecret`（已配置）；


## 8. 日志与排错

| 途径 | 关键字/条件 | 内容 |
|---|---|---|
| 应用日志 | `ERP入库单过账` | 类型跳过、无批次、未配地址、必填缺失、成功条数、失败原因、origin 为空 warn |
| `interface_logs` | `intf_id = MES2ERPAsnBack` | 调用时间、成功标记 |
| `interface_params` | `intf_id = <interface_logs.id>` | 完整请求/响应报文（对账用） |

## 9. 待确认项

| 编号 | 事项 | 当前实现 | 影响 |
|---|---|---|---|
| 1 | 上游推送 JSON 的采购单号字段名是否为 `poNumber` | In 类按 `poNumber` 接收 | 不一致则改 In 类一个属性名 |




## 10. 上线验证清单

- [ ] `interface_registers` 已登记 `MES2ERPAsnBack`（id/intf_type=upload/intf_url/log_flag）
- [ ] dev settings 已配 `interface.erp.asn.receiveUser=stephanie.ye`
- [ ] 后端部署（asn_back 两个类 + MatLotController + JOINT 接收侧两个文件）
- [ ] 前端发布（页面 + bower_components 平台补丁，两个文件都不能漏）
- [ ] 页面选择器能列出 103/106 调拨单
- [ ] 选一张 103 测试单：扫标签收满 → 点创建 → 收料成功、调拨单置 accept
- [ ] 106 测试单：上游推送后 `mes_line_transfer.segment2_id` 有值（PO 号落库 ✓）
- [ ] 106 收料完成 → `interface_params` 报文 `items.poNumber` = 采购单号（非回退的调拨单号）
- [ ] 应用日志 `ERP入库单过账` 出现推送成功记录
- [ ] `interface_logs`/`interface_params` 有完整报文
- [ ] ERP 侧确认单据过账成功（数量/仓位/批次一致）
- [ ] 反向验证：104 单收料不触发推送（日志出现类型跳过 info）
- [ ] 开关验证：`push.erp.asn.back.switch=N` 时不推送
