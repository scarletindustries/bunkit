// Table — NSTableView with a JS-shaped API.
//
// NSTableView pulls data through a datasource protocol, which maps badly onto a
// JS array. The wrapper inverts it: you hand over an array and a renderer, and
// it implements the protocol against them.

import { createDelegate, objc, str } from "../objc.ts";
import { ACTION_SELECTOR, actionTarget, View, type ViewOptions } from "./view.ts";
import { makeFont, type FontSpec } from "./controls.ts";
import {
  BorderType,
  LayoutAttribute,
  LayoutRelation,
  LineBreakMode,
  TableColumnResizing,
  TableViewColumnAutoresizingStyle,
  TableViewSelectionHighlightStyle,
  TableViewStyle,
  TextAlignment,
} from "./appkit.ts";

export interface Column<Row = any> {
  id: string;
  title: string;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  align?: "left" | "center" | "right";
  /** Absorb the table's spare width. Defaults to any column with no `width`. */
  flex?: boolean;
  /** Produce the cell text for a row. Defaults to `row[id]`. */
  value?: (row: Row, index: number) => string;
  /** Produce a whole view for the cell; wins over `value`. */
  render?: (row: Row, index: number) => View;
}

export interface TableOptions<Row = any> extends ViewOptions {
  columns: Column<Row>[];
  rows?: Row[];
  onSelect?: (row: Row | null, index: number) => void;
  onDoubleClick?: (row: Row, index: number) => void;
  rowHeight?: number;
  headers?: boolean;
  /** "plain" | "inset" | "sourceList" | "fullWidth" */
  style?: keyof typeof TableViewStyle;
  alternatingRows?: boolean;
  multiSelect?: boolean;
  font?: FontSpec | number;
}

export class Table<Row = any> extends View {
  readonly tableView: any;
  readonly scrollView: any;
  #rows: Row[] = [];
  #columns: Column<Row>[];
  #dataSource: any;
  #onSelect?: (row: Row | null, index: number) => void;
  #onDoubleClick?: (row: Row, index: number) => void;
  #font: any;
  // Views handed to AppKit must stay reachable from JS until AppKit lets go.
  #cellViews = new Set<any>();
  // The text each row's cells were last given, by row and then by column (in
  // `#columns` order). Written whenever a text cell is filled, so a new set of
  // rows can be compared against what is actually on screen.
  #shown = new Map<number, string[]>();

  constructor(options: TableOptions<Row>) {
    const scroll = objc.NSScrollView.alloc().init();
    scroll.setHasVerticalScroller_(true);
    scroll.setHasHorizontalScroller_(false);
    scroll.setAutohidesScrollers_(true);
    scroll.setBorderType_(BorderType.None);
    scroll.setDrawsBackground_(false);

    const tv = objc.NSTableView.alloc().init();
    tv.setStyle_(TableViewStyle[options.style ?? "Inset"]);
    tv.setUsesAlternatingRowBackgroundColors_(options.alternatingRows ?? false);
    tv.setAllowsMultipleSelection_(options.multiSelect ?? false);
    tv.setColumnAutoresizingStyle_(TableViewColumnAutoresizingStyle.Uniform);
    tv.setSelectionHighlightStyle_(TableViewSelectionHighlightStyle.Regular);
    tv.setRowHeight_(options.rowHeight ?? 24);
    if (options.headers === false) tv.setHeaderView_(null);

    scroll.setDocumentView_(tv);
    super(scroll, options);

    if (options.height === undefined && options.minHeight === undefined) {
      this.constrain("height", ">=", 120);
    }
    this.scrollView = scroll;
    this.tableView = tv;
    this.#columns = options.columns;
    this.#rows = options.rows ?? [];
    this.#onSelect = options.onSelect;
    this.#onDoubleClick = options.onDoubleClick;
    this.#font = options.font !== undefined ? makeFont(options.font) : null;

    // Slack goes to the columns marked `flex`, else to those with no explicit
    // width, else to the last one so the table never leaves a dead strip.
    const explicitFlex = options.columns.some((c) => c.flex);
    const anyAuto = options.columns.some((c) => c.width === undefined);
    options.columns.forEach((c, i) => {
      const flexible = explicitFlex
        ? !!c.flex
        : anyAuto
          ? c.width === undefined
          : i === options.columns.length - 1;
      this.addColumn(c, flexible);
    });
    this.installDataSource();
    tv.reloadData();
  }

  private addColumn(c: Column<Row>, flexible: boolean) {
    const col = objc.NSTableColumn.alloc().initWithIdentifier_(c.id);
    col.setTitle_(c.title);
    if (c.width !== undefined) col.setWidth_(c.width);
    if (c.minWidth !== undefined) col.setMinWidth_(c.minWidth);
    if (c.maxWidth !== undefined) col.setMaxWidth_(c.maxWidth);
    // Only columns in the autoresizing mask absorb slack when the table grows,
    // so a column given an explicit width keeps it.
    col.setResizingMask_(
      TableColumnResizing.UserResizing | (flexible ? TableColumnResizing.Autoresizing : 0),
    );
    this.tableView.addTableColumn_(col);
  }

  private installDataSource() {
    const self = this;
    this.#dataSource = createDelegate(
      {
        numberOfRowsInTableView_: () => self.#rows.length,

        // View-based tables: return a configured NSView for the cell. AppKit
        // recycles views through makeViewWithIdentifier:owner:.
        "tableView:viewForTableColumn:row:": (_tv: any, column: any, row: number) => {
          const colId = str(column.identifier());
          const spec = self.#columns.find((c) => c.id === colId);
          const index = Number(row);
          const data = self.#rows[index];
          if (!spec || data === undefined) return null;

          if (spec.render) {
            const v = spec.render(data, index);
            self.#cellViews.add(v);
            return v.native;
          }

          let cell = self.tableView.makeViewWithIdentifier_owner_(colId, self.#dataSource);
          if (!cell) {
            // An NSTextField handed straight back as the cell view draws its
            // text at the top of the row rather than the middle — a 26pt row
            // with a 13pt font leaves the glyphs 10pt above centre. The fix is
            // the structure AppKit expects: an NSTableCellView whose textField
            // is pinned to the vertical centre.
            cell = objc.NSTableCellView.alloc().init();
            cell.setIdentifier_(colId);

            const text = objc.NSTextField.labelWithString_("");
            text.setTranslatesAutoresizingMaskIntoConstraints_(false);
            text.setLineBreakMode_(LineBreakMode.TruncatingTail);
            text.setBordered_(false);
            text.setDrawsBackground_(false);
            if (self.#font) text.setFont_(self.#font);
            if (spec.align) {
              text.setAlignment_(
                spec.align === "center" ? TextAlignment.Center
                : spec.align === "right" ? TextAlignment.Right
                : TextAlignment.Left,
              );
            }
            cell.addSubview_(text);
            cell.setTextField_(text);

            for (const [attr, constant] of [
              [LayoutAttribute.Leading, 0],
              [LayoutAttribute.Trailing, 0],
              [LayoutAttribute.CenterY, 0],
            ] as Array<[number, number]>) {
              const c = objc.NSLayoutConstraint.constraintWithItem_attribute_relatedBy_toItem_attribute_multiplier_constant_(
                text, attr, LayoutRelation.Equal, cell, attr, 1.0, constant,
              );
              c.setActive_(true);
            }
            self.#cellViews.add(cell);
          }
          const text = self.#textOf(spec, data, index);
          cell.textField().setStringValue_(text);
          self.#remember(index, spec, text);
          return cell;
        },

        tableViewSelectionDidChange_: () => {
          const i = self.selectedIndex;
          self.#onSelect?.(i >= 0 ? (self.#rows[i] ?? null) : null, i);
        },
      },
      {
        protocols: ["NSTableViewDataSource", "NSTableViewDelegate"],
        name: "Table",
      },
    );
    this.retainJS(this.#dataSource);
    this.tableView.setDataSource_(this.#dataSource);
    this.tableView.setDelegate_(this.#dataSource);

    if (this.#onDoubleClick) {
      const t = actionTarget(() => {
        const i = this.selectedIndex;
        if (i >= 0 && this.#rows[i] !== undefined) this.#onDoubleClick!(this.#rows[i]!, i);
      });
      this.retainJS(t);
      this.tableView.setTarget_(t);
      this.tableView.setDoubleAction_(ACTION_SELECTOR);
    }
  }

  // --- data ----------------------------------------------------------------

  get rows(): Row[] {
    return this.#rows;
  }

  /**
   * Replace the rows, redrawing only what changed.
   *
   * A table refreshed from live data — a fixture list ten times a second, a
   * status list on every tick — mostly gets back the rows it already shows. A
   * full `reloadData` throws every visible cell away and builds it again, and
   * on a table of a few dozen rows that is tens of milliseconds of layout on the
   * main thread each time. So when every column is text, rows are added or
   * removed at the end to match the new count, and each cell AppKit is holding
   * is given its new text only if the text differs. What the table shows is the
   * same either way; the selection and the scroll position are kept.
   *
   * A table with a `render` column is reloaded in full: its cells are views the
   * caller builds, and only the caller knows whether a new one is needed.
   */
  set rows(v: Row[]) {
    const next = v ?? [];
    if (this.#columns.some((c) => c.render)) {
      this.#rows = next;
      this.reload();
      return;
    }
    // What AppKit believes the count is, not the old array's length: a caller
    // may have mutated the array it handed over and be handing it back.
    const before = Number(this.tableView.numberOfRows());
    this.#rows = next;
    const after = next.length;
    if (after < before) {
      this.tableView.removeRowsAtIndexes_withAnimation_(rangeSet(after, before - after), 0);
      for (const row of this.#shown.keys()) if (row >= after) this.#shown.delete(row);
    } else if (after > before) {
      // The new rows' cells come from the datasource, which reads `#rows`.
      this.tableView.insertRowsAtIndexes_withAnimation_(rangeSet(before, after - before), 0);
    }
    this.#refreshShown();
  }

  /** Throw every cell away and rebuild what is visible. */
  reload(): void {
    this.#cellViews.clear();
    this.#shown.clear();
    this.tableView.reloadData();
  }

  /** A cell's text, as the datasource and an in-place refresh both produce it. */
  #textOf(spec: Column<Row>, data: Row, index: number): string {
    const text = spec.value ? spec.value(data, index) : String((data as any)?.[spec.id] ?? "");
    return text ?? "";
  }

  /** Record the text a cell was just given. */
  #remember(index: number, spec: Column<Row>, text: string): void {
    let texts = this.#shown.get(index);
    if (!texts) {
      texts = [];
      this.#shown.set(index, texts);
    }
    texts[this.#columns.indexOf(spec)] = text;
  }

  /**
   * Give every cell AppKit still holds the text its row now has, touching only
   * the ones that changed.
   *
   * A recorded row whose cell AppKit has since recycled answers `nil` and is
   * forgotten; when it scrolls back in, the datasource fills it from `#rows`.
   */
  #refreshShown(): void {
    let columnIndex: number[] | undefined;
    for (const [row, texts] of this.#shown) {
      const data = this.#rows[row];
      if (data === undefined) {
        this.#shown.delete(row);
        continue;
      }
      for (let c = 0; c < this.#columns.length; c++) {
        const spec = this.#columns[c]!;
        const text = this.#textOf(spec, data, row);
        if (texts[c] === text) continue;
        // Columns can be dragged into a new order, so ask where each one is.
        columnIndex ??= this.#columns.map((col) => Number(this.tableView.columnWithIdentifier_(col.id)));
        const at = columnIndex[c]!;
        const cell = at < 0 ? null : this.tableView.viewAtColumn_row_makeIfNecessary_(at, row, false);
        if (!cell) {
          this.#shown.delete(row);
          break;
        }
        cell.textField().setStringValue_(text);
        texts[c] = text;
      }
    }
  }

  /** Refresh a single row without rebuilding the table. */
  reloadRow(index: number): void {
    const rows = objc.NSIndexSet.indexSetWithIndex_(index);
    const cols = objc.NSIndexSet.indexSetWithIndexesInRange_({
      location: 0,
      length: this.#columns.length,
    });
    this.tableView.reloadDataForRowIndexes_columnIndexes_(rows, cols);
  }

  append(row: Row): void {
    this.#rows.push(row);
    this.tableView.reloadData();
  }

  removeAt(index: number): void {
    this.#rows.splice(index, 1);
    this.tableView.reloadData();
  }

  /**
   * The rows on screen now: the first one's index and how many. For a caller whose rows
   * cost something to work out, and which only needs to work out the ones that are seen.
   */
  get visibleRows(): { first: number; count: number } {
    const range = this.tableView.rowsInRect_(this.tableView.visibleRect());
    return { first: Number(range.location), count: Number(range.length) };
  }

  // --- selection -----------------------------------------------------------

  get selectedIndex(): number {
    const i = this.tableView.selectedRow();
    return Number(i);
  }

  get selected(): Row | null {
    const i = this.selectedIndex;
    return i >= 0 ? (this.#rows[i] ?? null) : null;
  }

  get selectedIndexes(): number[] {
    const set = this.tableView.selectedRowIndexes();
    const out: number[] = [];
    let i = Number(set.firstIndex());
    // NSNotFound
    while (i >= 0 && i < 9007199254740991) {
      out.push(i);
      const next = Number(set.indexGreaterThanIndex_(i));
      if (next === i || next > 1e15) break;
      i = next;
    }
    return out;
  }

  select(index: number): void {
    if (index < 0) {
      this.tableView.deselectAll_(null);
      return;
    }
    this.tableView.selectRowIndexes_byExtendingSelection_(
      objc.NSIndexSet.indexSetWithIndex_(index), false,
    );
    this.tableView.scrollRowToVisible_(index);
  }

  onSelect(fn: (row: Row | null, index: number) => void): this {
    this.#onSelect = fn;
    return this;
  }
}

/** An `NSIndexSet` of `length` indexes from `location`. */
function rangeSet(location: number, length: number): any {
  return objc.NSIndexSet.indexSetWithIndexesInRange_({ location, length });
}
