// Forms the way macOS 26's own settings windows draw them: titled, rounded groups of rows —
// a label on the left, the controls after it — with a footnote under each group.
//
// Two things this gets right that hand-built forms keep getting wrong. Section titles are in
// title case, never capitals (the HIG retired all-caps headers). And every piece of running
// text has a width it wraps at: a wrapping label with no width wraps nowhere, and its
// natural width is the whole sentence on one line — which quietly makes a window two
// thousand points wide.
import { HStack, Separator, Spacer, VStack } from "./layout.ts";
import { Label } from "./controls.ts";
import type { View, ViewOptions } from "./view.ts";

/** One row of a {@link formSection}: a label, the controls, and a short note after them. */
export interface FormRow {
  /** What the row sets, on the left. Omit for a row that is all controls (a checkbox). */
  label?: string;
  /** The controls, in order. */
  controls: View[];
  /** A short note after the controls, in secondary text — what the setting means. */
  note?: string;
}

/** Options for {@link formSection}. */
export interface FormSectionOptions extends ViewOptions {
  /** The group's title, above it, in title case. */
  title?: string;
  /** Its rows, top to bottom. A view is a row as it is — a table, a line of text. */
  rows: (FormRow | View)[];
  /** A footnote under the group: why, or what to do. */
  footer?: string;
  /** How wide the labels column is, in points. Default 120. */
  labelWidth?: number;
  /** The width running text wraps at, in points. Default 560. */
  textWidth?: number;
}

/** The group's background: a fill a step up from the window, rounded. */
const GROUP_FILL = "quaternarySystemFill";
const GROUP_RADIUS = 10;

/**
 * A titled, rounded group of rows with a footnote — one section of a settings window. Returns
 * the stack; put it in the window's column. Rows are separated by hairlines inset from the
 * group's edge, as System Settings draws them.
 */
export function formSection(options: FormSectionOptions): VStack {
  const labelWidth = options.labelWidth ?? 120;
  const textWidth = options.textWidth ?? 560;
  const rows: View[] = [];
  options.rows.forEach((row, index) => {
    if (index > 0) rows.push(new Separator());
    rows.push(isRow(row) ? formRow(row, labelWidth, textWidth) : padded(row));
  });
  const group = new VStack(
    { spacing: 0, padding: { top: 2, bottom: 2, left: 0, right: 0 }, align: "fill", pack: "fill", background: GROUP_FILL, cornerRadius: GROUP_RADIUS },
    rows,
  );
  const children: View[] = [];
  if (options.title) {
    children.push(new Label({ text: options.title, font: { size: 13, weight: "semibold" } }));
  }
  children.push(group);
  if (options.footer) children.push(formNote(options.footer, textWidth));
  const { title: _t, rows: _r, footer: _f, labelWidth: _l, textWidth: _w, ...view } = options;
  return new VStack({ spacing: 8, align: "fill", pack: "fill", ...view }, children);
}

/** A line of running text for a form: secondary, wrapped at `width`. */
export function formNote(text: string, width = 560): Label {
  return new Label({ text, font: { size: 11 }, color: "secondaryLabel", wrap: true, maxWidth: width });
}

/** One row: the label, the controls, a note, and a spacer that lets the row stretch. */
function formRow(row: FormRow, labelWidth: number, textWidth: number): HStack {
  const children: View[] = [];
  if (row.label !== undefined) {
    children.push(new Label({ text: row.label, font: { size: 13 }, width: labelWidth }));
  }
  children.push(...row.controls);
  if (row.note) {
    // Short, and wrapped narrow: a row's note says what the setting means in a few words. A
    // longer explanation is the section's footer.
    children.push(new Label({ text: row.note, font: { size: 11 }, color: "secondaryLabel", wrap: true, maxWidth: Math.min(textWidth, 200) }));
  }
  children.push(new Spacer());
  return new HStack({ spacing: 10, padding: { top: 8, bottom: 8, left: 12, right: 12 }, align: "center" }, children);
}

/** A view given as a row, inset as the rows are. */
function padded(view: View): HStack {
  return new HStack({ spacing: 0, padding: { top: 8, bottom: 8, left: 12, right: 12 }, align: "fill", pack: "fill" }, [view]);
}

function isRow(row: FormRow | View): row is FormRow {
  return (row as FormRow).controls !== undefined;
}
