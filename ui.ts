import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

/**
 * SelectList 封装:初始焦点定位到 initialIndex,支持 description 与滚动提示。
 * 返回选中项的 value;取消返回 null。
 */
export async function pickFromList(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
  initialIndex: number,
): Promise<string | null> {
  if (items.length === 0) return null;
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    const list = new SelectList(items, Math.min(items.length, 8), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    if (initialIndex >= 0 && initialIndex < items.length) list.setSelectedIndex(initialIndex);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
