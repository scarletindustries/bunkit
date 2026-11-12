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
import { LayoutAttribute, LayoutRelation } from "./appkit.ts";
import { objc } from "../objc.ts";
import type { View, ViewOptions } from "./view.ts";

/** One row of a {@link formSection}: a label, the controls, and a short note after them. */
export interface FormRow {
  /** What the row sets, on the left. Omit for a row that is all controls (a checkbox). */
  label?: string;
  /**
   * A view in the label's place — a name with a detail under it, say. Wins over `label`. In a
   * `trailing` section it sits at the leading edge, as a label does.
   */
  leading?: View;
  /** The controls, in order. */
  controls: View[];
  /**
   * A short note, in secondary text — what the setting means. After the controls; in a
   * `trailing` section, under the label.
   */
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
  /**
   * Where each row's controls sit. `"leading"` (the default): straight after a column of labels.
   * `"trailing"`: at the row's trailing edge, with the label — and the note, under it — at the
   * leading edge, as System Settings lays out its rows.
   */
  controls?: "leading" | "trailing";
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
  const trailing = options.controls === "trailing";
  const rows: View[] = [];
  options.rows.forEach((row, index) => {
    if (index > 0) rows.push(new Separator());
    rows.push(
      !isRow(row) ? padded(row)
      : trailing ? trailingRow(row, labelWidth)
      : formRow(row, labelWidth, textWidth),
    );
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
  const { title: _t, rows: _r, footer: _f, labelWidth: _l, textWidth: _w, controls: _c, ...view } = options;
  return new VStack({ spacing: 8, align: "fill", pack: "fill", ...view }, children);
}

/** A line of running text for a form: secondary, wrapped at `width`. */
export function formNote(text: string, width = 560): Label {
  return new Label({ text, font: { size: 11 }, color: "secondaryLabel", wrap: true, maxWidth: width });
}

/** One row: the label, the controls, a note, and a spacer that lets the row stretch. */
function formRow(row: FormRow, labelWidth: number, textWidth: number): HStack {
  const children: View[] = [];
  if (row.leading) {
    children.push(row.leading);
  } else if (row.label !== undefined) {
    children.push(new Label({ text: row.label, font: { size: 13 }, width: labelWidth }));
  }
  children.push(...row.controls);
  if (row.note) {
    // Short, and wrapped narrow: a row's note says what the setting means in a few words. A
    // longer explanation is the section's footer.
    children.push(new Label({ text: row.note, font: { size: 11 }, color: "secondaryLabel", wrap: true, maxWidth: Math.min(textWidth, 200) }));
  }
  children.push(new Spacer());
  return held(new HStack({ spacing: 10, padding: { top: 8, bottom: 8, left: 12, right: 12 }, align: "center" }, children));
}

/**
 * One row as System Settings lays it out: the label (and the note under it) at the leading
 * edge, a spacer, and the controls at the trailing edge. The label column wraps at
 * `labelWidth`, so a long note pushes the row taller, never the controls off the edge.
 */
function trailingRow(row: FormRow, labelWidth: number): HStack {
  const children: View[] = [];
  const name = row.leading ?? (row.label !== undefined ? new Label({ text: row.label, font: { size: 13 } }) : undefined);
  if (name && row.note) {
    children.push(
      new VStack({ spacing: 2, align: "leading", pack: "fill" }, [
        name,
        new Label({ text: row.note, font: { size: 11 }, color: "secondaryLabel", wrap: true, maxWidth: labelWidth }),
      ]),
    );
  } else if (name) {
    children.push(name);
  } else if (row.note) {
    children.push(new Label({ text: row.note, font: { size: 11 }, color: "secondaryLabel", wrap: true, maxWidth: labelWidth }));
  }
  children.push(new Spacer());
  children.push(...row.controls);
  // The same insets as a leading row, a little taller: a row of one switch is still a row.
  return held(new HStack({ spacing: 10, padding: { top: 8, bottom: 8, left: 12, right: 12 }, align: "center", minHeight: 40 }, children));
}

/** A row's padding above and below its tallest view, in points. */
const ROW_INSET = 8;

/**
 * Make a centred row keep its top and bottom insets, whatever is in it. Required constraints:
 * every view in the row stays at least {@link ROW_INSET} from the row's top and bottom, so the
 * row is its tallest view plus the insets, and the shorter ones stay centred.
 *
 * Needed because the stack's own `edgeInsets` don't hold on this axis. In a stack whose views are
 * centred across it, `NSStackView` asks for the insets only at its hugging priority (250 by
 * default), as an *equality* per view, with nothing but `>= 0` required — so the row shrank to
 * its tallest view and the padding went (measured: a title over a two-line note sat 1 point under
 * the hairline above it, and a note wrapped narrower than it was measured lost its last line).
 * Raising that priority is no fix: the equalities of a 24-point switch and a 46-point label can't
 * both hold, and at 750 the switch won and the label was squashed to 6 points.
 *
 * Side effect: adds two constraints per view (not the spacer, which has no height of its own) and
 * keeps them alive with the row. Returns the row.
 */
function held(row: HStack): HStack {
  const views = row.children.filter((child) => !(child instanceof Spacer));
  for (const view of views) {
    for (const [first, second, attribute] of [
      [view.native, row.native, LayoutAttribute.Top],
      [row.native, view.native, LayoutAttribute.Bottom],
    ] as const) {
      // first.attr >= second.attr + inset, read as: the view's top is at least an inset below
      // the row's, and the row's bottom at least an inset below the view's.
      const c = objc.NSLayoutConstraint.constraintWithItem_attribute_relatedBy_toItem_attribute_multiplier_constant_(
        first, attribute, LayoutRelation.GreaterThanOrEqual, second, attribute, 1.0, ROW_INSET,
      );
      c.setActive_(true);
      row.retainJS(c);
    }
  }
  return row;
}

/** A view given as a row, inset as the rows are. */
function padded(view: View): HStack {
  return new HStack({ spacing: 0, padding: { top: 8, bottom: 8, left: 12, right: 12 }, align: "fill", pack: "fill" }, [view]);
}

function isRow(row: FormRow | View): row is FormRow {
  return (row as FormRow).controls !== undefined;
}
