# Token 统计口径

统计来自模型响应的 `usage` / `usageMetadata`，不根据字符数猜测 Token。缺失字段保留为未知；汇总同时保存数值与上报请求数。真实的 0 与未提供字段分别显示。

| 接口 | 总输入 | 总输出 | 缓存读取 | 缓存写入 | 推理 |
| --- | --- | --- | --- | --- | --- |
| OpenAI Chat | `prompt_tokens` | `completion_tokens` | `prompt_tokens_details.cached_tokens` | 若返回 `prompt_tokens_details.cache_write_tokens` | `completion_tokens_details.reasoning_tokens` |
| OpenAI Responses | `input_tokens` | `output_tokens` | `input_tokens_details.cached_tokens` | `input_tokens_details.cache_write_tokens` | `output_tokens_details.reasoning_tokens` |
| DeepSeek Chat | `prompt_tokens` | `completion_tokens` | `prompt_cache_hit_tokens`，兼容标准缓存明细 | 未提供时保持未知 | 标准输出明细 |
| Claude Messages | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` | `output_tokens` | `cache_read_input_tokens` | `cache_creation_input_tokens` | 未单独上报时保持未知 |
| Gemini | `promptTokenCount + toolUsePromptTokenCount` | `candidatesTokenCount + thoughtsTokenCount` | `cachedContentTokenCount` | 未提供时保持未知 | `thoughtsTokenCount` |

总 Token 优先采用接口的 `total_tokens` / `totalTokenCount`；当接口未提供总量、但总输入和总输出均已知时，才按两者之和计算。缓存和推理属于输入、输出的子项，不重复加入总量。DeepSeek 额外保留 `prompt_cache_miss_tokens`，Gemini 额外保留工具输入量。

Chat 流式请求默认发送 `stream_options.include_usage=true`，解析最终 `choices: []` 的用量块。用户可在额外 Body 中覆盖该设置；供应商不返回或连接中断时，统计展示已收到的数据及覆盖请求数。Claude 流的开始和增量 usage 合并；Gemini 和 Responses 使用最新用量。

统计包括实际答题的完成、失败、停止、返回不完整、耗时与首个响应时间。首个响应包含推理分片；它不是严格的供应商首 Token 延迟。连接测试、模型列表、冷却拦截不进入答题统计。完成率为完成次数 / 全部实际请求次数，返回不完整的完成请求另行标出。

按浏览器本地日期、模型、题型、协议汇总，最近 365 天最多 12,000 个汇总桶；不存题干、答案、密钥或网页地址。未来版本升级前的历史数据无法补算。备份包含设置与统计，恢复使用替换语义，重复导入不叠加；旧版只含设置的文件保留现有统计。设置与统计经过校验后在同一次本地存储写入中恢复。

核对的官方来源（2026-10-22）：

- [OpenAI Chat 流式 usage](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [OpenAI 缓存口径及写入字段](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI Responses 官方 SDK usage 类型](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_usage.py)
- [Claude 缓存统计口径](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance)
- [Gemini UsageMetadata](https://ai.google.dev/api/generate-content#UsageMetadata)
- [DeepSeek Chat usage](https://api-docs.deepseek.com/api/create-chat-completion/)
