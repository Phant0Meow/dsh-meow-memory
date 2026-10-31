/** DOM 所属范围按视图实例划分；相同 session/key 可以同时出现在多个面板。 */
export function chatFlows(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-chat-flow]'))
    .filter((flow) => flow.closest('[data-conversation-scroll]') === root)
    // 工具/思考详情也可能渲染一个嵌套 flow；它不是另一个可写的会话消息流。
    .filter((flow) => flow.parentElement?.closest('[data-chat-flow]')?.closest('[data-conversation-scroll]') !== root)
}

/** 不穿透嵌套 flow（例如继承上下文或嵌入的另一会话）。 */
export function flowElements(flow: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(flow.querySelectorAll<HTMLElement>(selector))
    .filter((element) => element.closest('[data-chat-flow]') === flow)
}
