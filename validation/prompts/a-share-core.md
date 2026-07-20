继续开发当前“算力趋势研判台”工程。上一次只生成了 package.json，并因使用了不兼容 PowerShell 的 mkdir 写法而中断；src、public、test 目录现在已经存在。

本次只完成核心层，不开发页面：

1. 将 package.json 改为 ESM，配置 `npm test` 使用 `node --test`，配置 `npm start` 指向后续 server.js。
2. 在 src 中实现可同时供 Node 测试和浏览器使用的纯 JavaScript 模块：
   - 严格 CSV 解析，必填 date/code/name/close/change_pct/volume/amount，可选 category；中文错误覆盖空文件、缺列、日期非法、数值非法、重复 date+code。
   - 时间序列分组、等权归一化板块指数。
   - SMA、动量、RSI14、年化波动率、最大回撤、量能比、宽度与上涨家数比例。
   - 透明趋势评分，返回 score、label（偏强/震荡/偏弱）、contributions。
   - 风险信号：趋势量能背离、指数上涨但宽度下降、20 日回撤过大、波动率异常。
   - 个股汇总、相对强弱、按字段排序和 category 筛选。
3. 生成确定性的演示数据模块：至少 130 个工作日、8 只不同算力细分股票，禁止 Math.random；数据明确只用于演示。
4. 在 test 中使用 node:test 编写全面测试，至少覆盖上述每类逻辑及边界。
5. 运行 npm test 和所有 JS 文件的 `node --check`，自行修复直到全部通过。

直接创建文件和运行命令，不要只解释。命令必须使用 PowerShell 兼容写法。完成后简短汇报测试数量与文件。
