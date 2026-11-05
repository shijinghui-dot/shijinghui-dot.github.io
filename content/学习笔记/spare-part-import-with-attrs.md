# 备件期初库存导入扩展：支持自定义属性批量导入

## Context

需求跟踪表条目（设备管理→设备备件，低优先级，2026/9/22，陈政义）：

> 配件类型可配置，配件有通用字段（编号、名称、供应商、库存数量、尺寸、重量、材质等），不同类型应支持自定义属性（**有，但数据不能批量导入**）。

现状：期初库存导入页 [cwip-machine-setup-spare-part-init.html](file:///c:/Users/jinghui.shi/project/plantu-xmes-longsys-client/app/elements/cust-bundles/ui/cwip/cwip-machine-setup-spare-part-init.html) 已有固定列导入（`spare_parts/parts_init_loader`），但自定义属性数据无法批量导入。

用户决策：**扩展现有期初导入页** + **后端新增导入端点** + **属性列动态生成**（按 `attributes` 表中 SpareParts 实体的属性定义，不硬编码）。

自定义属性写入走通用 EAV 框架：`attr_datas` 表（`attr_id` + `attr_key` 键，attr_key=备件 id），写入经 `AttributeUtil.updateAttrDataList`（对 SpareParts 跳过实例校验，直接可用），校验属性定义（通用代码/数字格式/长度）。

**发现并顺带修复的现存缺陷**：`things-import-excel` 组件（2025-09 本地改造）的 `_findFieldName` 只匹配 `col.name`/`col.header.text`/`中文#english`，不认 `col.fieldName`；导入页 `importColumns` 目前是 `{fieldName, header:{text}}` 形状 → 表头映射实际失效，靠"模板第 1 行英文键透传"碰巧工作（伴随伪错误 toast）。本次给每列补 `name` 字段修复。

## 总体设计

```
导入页(cwip-machine-setup-spare-part-init)
  ├─ attached: GET attr_datas/0/findByEntityName?entity_name=SpareParts → 动态构建 importColumns（基础列+属性列）
  ├─ 模板下载: GET spare_parts/parts_import_template（blob 下载，动态两行表头）
  └─ 导入: things-import-excel 解析 → 行转换（提取 attr_* → row.attrs）→ POST spare_parts/parts_loader
后端 SparePartsController（类级 @Transactional，一个事务）
  ├─ POST parts_loader: 行校验 → insertBatch(备件) → 按 name 回查 id → insertBatch(库存) → 逐行写 attr_datas
  └─ GET parts_import_template: Resource("SpareParts") → attributes 定义 → EasyExcelUtils.exportCustomExcel 动态模板
维护页(cwip-machine-setup-spare-part) 加属性 Tab：导入的属性值可查看/编辑（复用 things-unit-attribute-tab）
```

## 后端改动（d:\plantu-xmes-longsys-server）

### 1. SpareParts 实体加瞬态字段
文件：`src\main\java\xyz\xmes\machine\entity\SpareParts.java`（在 L172-173 `storeLocName` 后）

```java
@Ignore
private List<AttrData> attrs;
```
+ getter/setter，import `xyz.xmes.wip.entity.AttrData`。沿用现有 `@Ignore` 风格（L169-173）。老端点请求体不含 `attrs` 时为 null，行为不变。

### 2. SparePartsController 抽取共享校验
文件：`src\main\java\xyz\xmes\machine\rest\SparePartsController.java`

- 把 `importIncomingSku`（parts_init_loader，L148 起）的 for 循环体（逐行校验：WIP-0324 重名、WIP-0325 仓库、WIP-0326 库位、WIP-0327 匹配、WIP-0328 日期、WIP-0329 单位/易损件，及字段赋值）机械抽取为 `private void validateAndPrepareImportPart(SpareParts part, int excelRowNo)`，老端点循环体改为调用它（纯搬移，契约不变）。文件内重名检查（WIP-0323）留在调用方。
- 新消息 ID 用 `WIP-0350/0351`（使用前 grep 确认未占用）。

### 3. 新端点 POST /rest/spare_parts/parts_loader
```java
public Map<String, String> importPartsWithAttrs(@RequestBody List<SpareParts> importList)
```
1. 空列表 → `INVC-0087`；按 name 查文件内重名 → `WIP-0323`
2. 循环调 `validateAndPrepareImportPart(part, i + 2)`
3. `insertBatch(SpareParts.class, importList)`（同老端点构建 SparePartsInventory 并 insertBatch）
4. **按 name 回查 id**（`Query names in (...)`，不依赖 insertBatch 是否回填 id）
5. attrs 非空的行：`AttributeUtil.updateAttrDataList("SpareParts", id, part.getAttrs())`，catch `ElidomServiceException` 包裹为 `WIP-0351 : 导入第[{0}]行: 备件[{1}]自定义属性写入失败: {2}`
6. 返回 `{"info": "成功导入备件:N条(含自定义属性)"}`

请求行形状（Jackson 全局 snake_case，`attrs` 反序列化为 `List<AttrData>`）：
```json
{ "name": "P001", "...": "基础字段同现有", "attrs": [{ "attr_name": "COLOR", "attr_value": "RED", "null_flag": false }] }
```

### 4. 新端点 GET /rest/spare_parts/parts_import_template
```java
public void downloadImportTemplate(HttpServletResponse response)
```
1. Resource 按 name="SpareParts" 查；**查不到不抛错**，退化为纯基础列模板
2. attributes 按 entity_id + domain/site 查，`seq_num` 排序（与 AttrDataController.findByEntityName 同款查询）
3. 动态两行表头（复刻现有静态模板结构：行1=英文键、行2=中文）：
   - 行1：11 个基础键 + `attr_<attr_name>` 逐属性
   - 行2：基础中文（含 `易损件#easy_break` 形式）+ 属性中文（`attr_desc || attr_name`；**检测重复 attr_desc，重复者用 `attr_desc#attr_<name>`**）
   - `headNames` = 两行按列 zip 成 `List<List<String>>`
4. 样例 1 行（明显假数据，属性列空），sheetName 必须 `Sheet1`
5. `EasyExcelUtils.exportCustomExcel(response, sampleRows, "备件期初库存导入模板", headNames, "Sheet1")`（支持动态表头，L198；注意它会 clear 传入 list）

### 5. AttrDataController.findByEntityName 增量扩展
文件：`src\main\java\xyz\xmes\wip\rest\AttrDataController.java`（L136-152 循环内加两键）：
```java
attrDataMap.put("attr_fmt", attribute.getAttrFmt());
attrDataMap.put("allow_blank_flag", checkValue(attribute.getAllowBlankFlag(), false));
```
纯增量键（前端必填校验依赖 `allow_blank_flag`），现有消费者只读已知键。

## 前端改动（plantu-xmes-longsys-client）

### 6. 导入页 cwip-machine-setup-spare-part-init.html（核心）
1. **新增 ajax**：`ajx-attr-defs`（`attr_datas/0/findByEntityName`，last-response=`attrDefs`）、`ajx-parts-import`（`spare_parts/parts_loader`）、`ajx-template-download`（`spare_parts/parts_import_template`）
2. **importColumns 修复 + 动态化**：静态列改名 `baseImportColumns` 且每项补 `name`（与 `fieldName` 同值，修复缺陷）；监听 `ajx-attr-defs.things-ajax-response` → `_buildImportColumns()` = 基础列 + 属性列 `{name: 'attr_' + attr_name, header: {text: attr_desc || attr_name}}`
3. **attached 加载定义**：`this.requestAjax('ajx-attr-defs', { entity_name: 'SpareParts' })`
4. **模板下载改 blob**（替换 L143-147 静态文件跳转）：在 `listeners` 静态声明 `ajx-template-download.things-ajax-request`（`xhr.responseType='blob'`）/ `.things-ajax-response`（objectURL + a.click 下载，照抄 things-behavior-remote-export.html L89-113 片段，GET 方式）
5. **行转换**（excel-process-finish 处理，L166-224）：
   - 基础字段必填校验保留
   - 必填属性校验：`attrDefs` 中 `allow_blank_flag === false` 的属性值为空 → `showErrorPopup('CMN_require_data_is_empty', {key: attr_desc})`
   - 提取：行内 `attr_` 前缀键 → `attrs.push({attr_name: key.slice(5), attr_value, null_flag: false})`（**只收非空值**），并 delete 原键；`item.attrs = attrs`
6. **发送目标**改 `ajx-parts-import`（body=importData）；响应监听键换成 `ajx-parts-import.things-ajax-response`（复用 `onOpenInvResponse` 的 swal + 刷新）

### 7. 维护页 cwip-machine-setup-spare-part.html 加属性 Tab
照抄 [wip-setup-material.html](file:///c:/Users/jinghui.shi/project/plantu-xmes-longsys-client/app/elements/biz-bundles/ui/invm/wip-setup-material.html) 的接线（L44/100/126/145/161/283-296）：
1. `things-template-setup` 加 `id="tmp-tab"`
2. `sections` 追加 `{title: t('label.property'), tabId: 'tab-attribute', isTab: false}`
3. `tab-content-1` 后加 `<div class="div-tab-content" tab-content-2>` 内放 `<things-unit-attribute-tab id="tab-attribute" class="flex" entity-name="SpareParts" resource="[[formData]]">`
4. listeners 加 `'tmp-tab.things-layout-tab-changed': 'onTabChanged'`；`tabId==='tab-attribute'` 时 `this.$[tabId].request()`
5. `_resetTabs` 改为遍历 sections 对存在者 reset（顺带清理现有引用不存在 `tab-segment` 的死代码）
6. `formData` 已在 `onGridRowDataSelect` 赋值（含 id），直接绑定；attr_key=备件 id，与导入写入一致

### 8. 数据准备（种子，实施时确认）
- `resources` 表需存在 `name='SpareParts'` 行；`attributes` 表为其配置属性（name 英文唯一、description 中文表头、seq_num、attr_fmt、attr_size、allow_blank_flag、可选 valid_tbl_id）
- 若已配置（需求说"有"），跳过

## 验证清单

| # | 场景 | 期望 |
|---|---|---|
| 1 | 配 2 个属性后下载模板 | 两行表头含 `attr_XXX` + 中文；1 样例行；sheet 名 Sheet1；无属性时退化为 11 列基础模板 |
| 2 | 含属性正常导入 | "成功导入备件:N条"；spare_parts / spare_parts_inventory / attr_datas（attr_key=备件 id）三表一致 |
| 3 | 导入后维护页选行 → 属性 Tab | 显示属性值，可编辑保存 |
| 4 | 基础字段各类错误 | WIP-0323~0329 原行为不变，带"导入第N行" |
| 5 | 必填属性留空 | 前端 `CMN_require_data_is_empty`；直调 API 后端 WIP-0350 |
| 6 | 属性值错（代码表/非数字/超长） | SYS-0015 / BAS-0073 / SYS-0016，经 WIP-0351 带行号 |
| 7 | 属性列全空行 | 正常导入，不产生 attr_datas 行 |
| 8 | 表头手工改写（纯中文/`中文#english`） | 映射正确（依赖 name 补齐）；陌生表头 → invalid input toast，不脏写 |
| 9 | 回归：旧端点直调（无 attrs） | 与改动前完全一致 |
| 10 | 回归：纯基础列模板导入 | 正常（importColumns 修复后需回归） |

## 风险与边界
- **通用代码属性录入口径**：属性按 `CodeDetail.name` 校验（SYS-0015），基础列 unit/easy_break 按 description 校验 —— 绑定通用代码的属性列要求填代码值，可接受报错引导
- **空属性单元格**：前端只发非空值，避免 NUMBER 空值误报；必填性由前后端缺失检查负责
- **事务**：类级 @Transactional，任一行失败全量回滚，无半截数据
- **不做项**：模板下拉数据验证（如"是,否"）不复刻，靠 WIP-0329 后端兜底；配件"类型→属性"分级建模（SpareParts 无类型字段）不在本次范围，属性为 SpareParts 实体级配置

## 关键文件
- 后端：`SpareParts.java`、`SparePartsController.java`、`AttrDataController.java`
- 前端：`cwip-machine-setup-spare-part-init.html`、`cwip-machine-setup-spare-part.html`
- 参考：`AttributeUtil.java`、`EasyExcelUtils.java`、`things-import-excel.html`、`things-behavior-remote-export.html`、`things-unit-attribute-tab.html`
