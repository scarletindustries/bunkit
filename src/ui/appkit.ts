// The AppKit enum values Layer 3 uses, grouped into readable namespaces.
//
// Every value here is *derived* from src/generated/constants.ts, which is
// produced by asking clang for the real value of each identifier against the
// installed SDK. Hand-transcribing these is a trap: on arm64 macOS, for one
// example, NSTextAlignment uses the iOS ordering (Left, Center, Right) rather
// than AppKit's historical (Left, Right, Center), so a hand-written table
// silently centres everything you asked to right-align.
//
// `pick` throws at import time if a name has disappeared from the SDK, so a
// macOS upgrade that renames a constant is a startup error rather than a
// mysteriously misbehaving control.

import * as C from "../generated/constants.ts";

const all = C as unknown as Record<string, number | bigint>;

function pick<K extends string>(map: Record<K, string>): Record<K, number> {
  const out = {} as Record<K, number>;
  const missing: string[] = [];
  for (const key of Object.keys(map) as K[]) {
    const symbol = map[key];
    const v = all[symbol];
    if (v === undefined) missing.push(symbol);
    else out[key] = Number(v);
  }
  if (missing.length) {
    throw new Error(
      `AppKit constants missing from the generated SDK dump (${C.SDK_VERSION}): ` +
        `${missing.join(", ")}. Re-run: bun run tools/gen-constants.ts`,
    );
  }
  return out;
}

export const SDK_VERSION = C.SDK_VERSION;

export const WindowStyleMask = pick({
  Borderless: "NSWindowStyleMaskBorderless",
  Titled: "NSWindowStyleMaskTitled",
  Closable: "NSWindowStyleMaskClosable",
  Miniaturizable: "NSWindowStyleMaskMiniaturizable",
  Resizable: "NSWindowStyleMaskResizable",
  UtilityWindow: "NSWindowStyleMaskUtilityWindow",
  TexturedBackground: "NSWindowStyleMaskTexturedBackground",
  UnifiedTitleAndToolbar: "NSWindowStyleMaskUnifiedTitleAndToolbar",
  HUDWindow: "NSWindowStyleMaskHUDWindow",
  FullScreen: "NSWindowStyleMaskFullScreen",
  FullSizeContentView: "NSWindowStyleMaskFullSizeContentView",
  NonactivatingPanel: "NSWindowStyleMaskNonactivatingPanel",
});

export const BackingStore = pick({ Buffered: "NSBackingStoreBuffered" });

export const ActivationPolicy = pick({
  Regular: "NSApplicationActivationPolicyRegular",
  Accessory: "NSApplicationActivationPolicyAccessory",
  Prohibited: "NSApplicationActivationPolicyProhibited",
});

export const Orientation = pick({
  Horizontal: "NSUserInterfaceLayoutOrientationHorizontal",
  Vertical: "NSUserInterfaceLayoutOrientationVertical",
});

export const StackDistribution = pick({
  GravityAreas: "NSStackViewDistributionGravityAreas",
  Fill: "NSStackViewDistributionFill",
  FillEqually: "NSStackViewDistributionFillEqually",
  FillProportionally: "NSStackViewDistributionFillProportionally",
  EqualSpacing: "NSStackViewDistributionEqualSpacing",
  EqualCentering: "NSStackViewDistributionEqualCentering",
});

export const StackGravity = pick({
  Top: "NSStackViewGravityTop",
  Leading: "NSStackViewGravityLeading",
  Center: "NSStackViewGravityCenter",
  Bottom: "NSStackViewGravityBottom",
  Trailing: "NSStackViewGravityTrailing",
});

export const LayoutAttribute = pick({
  NotAnAttribute: "NSLayoutAttributeNotAnAttribute",
  Left: "NSLayoutAttributeLeft",
  Right: "NSLayoutAttributeRight",
  Top: "NSLayoutAttributeTop",
  Bottom: "NSLayoutAttributeBottom",
  Leading: "NSLayoutAttributeLeading",
  Trailing: "NSLayoutAttributeTrailing",
  Width: "NSLayoutAttributeWidth",
  Height: "NSLayoutAttributeHeight",
  CenterX: "NSLayoutAttributeCenterX",
  CenterY: "NSLayoutAttributeCenterY",
  FirstBaseline: "NSLayoutAttributeFirstBaseline",
  LastBaseline: "NSLayoutAttributeLastBaseline",
});

export const LayoutRelation = pick({
  LessThanOrEqual: "NSLayoutRelationLessThanOrEqual",
  Equal: "NSLayoutRelationEqual",
  GreaterThanOrEqual: "NSLayoutRelationGreaterThanOrEqual",
});

// NSLayoutPriority values are floats, so they come straight from the dump.
export const LayoutPriority = {
  Required: Number(all.NSLayoutPriorityRequired ?? 1000),
  DefaultHigh: Number(all.NSLayoutPriorityDefaultHigh ?? 750),
  DragThatCanResizeWindow: Number(all.NSLayoutPriorityDragThatCanResizeWindow ?? 510),
  WindowSizeStayPut: Number(all.NSLayoutPriorityWindowSizeStayPut ?? 500),
  DragThatCannotResizeWindow: Number(all.NSLayoutPriorityDragThatCannotResizeWindow ?? 490),
  DefaultLow: Number(all.NSLayoutPriorityDefaultLow ?? 250),
  FittingSizeCompression: Number(all.NSLayoutPriorityFittingSizeCompression ?? 50),
} as const;

export const TextAlignment = pick({
  Left: "NSTextAlignmentLeft",
  Center: "NSTextAlignmentCenter",
  Right: "NSTextAlignmentRight",
  Justified: "NSTextAlignmentJustified",
  Natural: "NSTextAlignmentNatural",
});

export const LineBreakMode = pick({
  WordWrapping: "NSLineBreakByWordWrapping",
  CharWrapping: "NSLineBreakByCharWrapping",
  Clipping: "NSLineBreakByClipping",
  TruncatingHead: "NSLineBreakByTruncatingHead",
  TruncatingTail: "NSLineBreakByTruncatingTail",
  TruncatingMiddle: "NSLineBreakByTruncatingMiddle",
});

export const BezelStyle = pick({
  Rounded: "NSBezelStyleRounded",
  RegularSquare: "NSBezelStyleRegularSquare",
  Disclosure: "NSBezelStyleDisclosure",
  ShadowlessSquare: "NSBezelStyleShadowlessSquare",
  Circular: "NSBezelStyleCircular",
  TexturedSquare: "NSBezelStyleTexturedSquare",
  HelpButton: "NSBezelStyleHelpButton",
  SmallSquare: "NSBezelStyleSmallSquare",
  TexturedRounded: "NSBezelStyleTexturedRounded",
  RoundRect: "NSBezelStyleRoundRect",
  Recessed: "NSBezelStyleRecessed",
  RoundedDisclosure: "NSBezelStyleRoundedDisclosure",
  Inline: "NSBezelStyleInline",
  Glass: "NSBezelStyleGlass",
});

export const ButtonType = pick({
  MomentaryLight: "NSButtonTypeMomentaryLight",
  PushOnPushOff: "NSButtonTypePushOnPushOff",
  Toggle: "NSButtonTypeToggle",
  Switch: "NSButtonTypeSwitch",
  Radio: "NSButtonTypeRadio",
  MomentaryChange: "NSButtonTypeMomentaryChange",
  OnOff: "NSButtonTypeOnOff",
  MomentaryPushIn: "NSButtonTypeMomentaryPushIn",
  Accelerator: "NSButtonTypeAccelerator",
  MultiLevelAccelerator: "NSButtonTypeMultiLevelAccelerator",
});

export const ControlState = pick({
  Mixed: "NSControlStateValueMixed",
  Off: "NSControlStateValueOff",
  On: "NSControlStateValueOn",
});

export const ControlSize = pick({
  Regular: "NSControlSizeRegular",
  Small: "NSControlSizeSmall",
  Mini: "NSControlSizeMini",
  Large: "NSControlSizeLarge",
  ExtraLarge: "NSControlSizeExtraLarge",
});

export const ImageScaling = pick({
  ProportionallyDown: "NSImageScaleProportionallyDown",
  AxesIndependently: "NSImageScaleAxesIndependently",
  None: "NSImageScaleNone",
  ProportionallyUpOrDown: "NSImageScaleProportionallyUpOrDown",
});

export const ImagePosition = pick({
  NoImage: "NSNoImage",
  ImageOnly: "NSImageOnly",
  ImageLeft: "NSImageLeft",
  ImageRight: "NSImageRight",
  ImageBelow: "NSImageBelow",
  ImageAbove: "NSImageAbove",
  ImageOverlaps: "NSImageOverlaps",
  ImageLeading: "NSImageLeading",
  ImageTrailing: "NSImageTrailing",
});

export const TableViewStyle = pick({
  Automatic: "NSTableViewStyleAutomatic",
  FullWidth: "NSTableViewStyleFullWidth",
  Inset: "NSTableViewStyleInset",
  SourceList: "NSTableViewStyleSourceList",
  Plain: "NSTableViewStylePlain",
});

export const TableColumnResizing = pick({
  NoResizing: "NSTableColumnNoResizing",
  Autoresizing: "NSTableColumnAutoresizingMask",
  UserResizing: "NSTableColumnUserResizingMask",
});

export const TableViewColumnAutoresizingStyle = pick({
  None: "NSTableViewNoColumnAutoresizing",
  Uniform: "NSTableViewUniformColumnAutoresizingStyle",
  Sequential: "NSTableViewSequentialColumnAutoresizingStyle",
  ReverseSequential: "NSTableViewReverseSequentialColumnAutoresizingStyle",
  LastColumnOnly: "NSTableViewLastColumnOnlyAutoresizingStyle",
  FirstColumnOnly: "NSTableViewFirstColumnOnlyAutoresizingStyle",
});

export const TableViewSelectionHighlightStyle = pick({
  None: "NSTableViewSelectionHighlightStyleNone",
  Regular: "NSTableViewSelectionHighlightStyleRegular",
  SourceList: "NSTableViewSelectionHighlightStyleSourceList",
});

export const BorderType = pick({
  None: "NSNoBorder",
  Line: "NSLineBorder",
  Bezel: "NSBezelBorder",
  Groove: "NSGrooveBorder",
});

export const TitlePosition = pick({
  NoTitle: "NSNoTitle",
  AboveTop: "NSAboveTop",
  AtTop: "NSAtTop",
  BelowTop: "NSBelowTop",
  AboveBottom: "NSAboveBottom",
  AtBottom: "NSAtBottom",
  BelowBottom: "NSBelowBottom",
});

export const BoxType = pick({
  Primary: "NSBoxPrimary",
  Separator: "NSBoxSeparator",
  Custom: "NSBoxCustom",
});

export const AlertStyle = pick({
  Warning: "NSAlertStyleWarning",
  Informational: "NSAlertStyleInformational",
  Critical: "NSAlertStyleCritical",
});

export const ModalResponse = pick({
  Stop: "NSModalResponseStop",
  Abort: "NSModalResponseAbort",
  Continue: "NSModalResponseContinue",
  OK: "NSModalResponseOK",
  Cancel: "NSModalResponseCancel",
  AlertFirstButton: "NSAlertFirstButtonReturn",
  AlertSecondButton: "NSAlertSecondButtonReturn",
  AlertThirdButton: "NSAlertThirdButtonReturn",
});

export const ProgressIndicatorStyle = pick({
  Bar: "NSProgressIndicatorStyleBar",
  Spinning: "NSProgressIndicatorStyleSpinning",
});

export const VisualEffectMaterial = pick({
  Titlebar: "NSVisualEffectMaterialTitlebar",
  Selection: "NSVisualEffectMaterialSelection",
  Menu: "NSVisualEffectMaterialMenu",
  Popover: "NSVisualEffectMaterialPopover",
  Sidebar: "NSVisualEffectMaterialSidebar",
  HeaderView: "NSVisualEffectMaterialHeaderView",
  Sheet: "NSVisualEffectMaterialSheet",
  WindowBackground: "NSVisualEffectMaterialWindowBackground",
  HUDWindow: "NSVisualEffectMaterialHUDWindow",
  FullScreenUI: "NSVisualEffectMaterialFullScreenUI",
  ToolTip: "NSVisualEffectMaterialToolTip",
  ContentBackground: "NSVisualEffectMaterialContentBackground",
  UnderWindowBackground: "NSVisualEffectMaterialUnderWindowBackground",
  UnderPageBackground: "NSVisualEffectMaterialUnderPageBackground",
});

export const VisualEffectBlendingMode = pick({
  BehindWindow: "NSVisualEffectBlendingModeBehindWindow",
  WithinWindow: "NSVisualEffectBlendingModeWithinWindow",
});

export const VisualEffectState = pick({
  FollowsWindowActiveState: "NSVisualEffectStateFollowsWindowActiveState",
  Active: "NSVisualEffectStateActive",
  Inactive: "NSVisualEffectStateInactive",
});

export const EventModifierFlags = pick({
  CapsLock: "NSEventModifierFlagCapsLock",
  Shift: "NSEventModifierFlagShift",
  Control: "NSEventModifierFlagControl",
  Option: "NSEventModifierFlagOption",
  Command: "NSEventModifierFlagCommand",
  NumericPad: "NSEventModifierFlagNumericPad",
  Function: "NSEventModifierFlagFunction",
});

// Font weights are floats; NSFontWeightRegular is 0.
export const FontWeight = {
  UltraLight: Number(all.NSFontWeightUltraLight ?? -0.8),
  Thin: Number(all.NSFontWeightThin ?? -0.6),
  Light: Number(all.NSFontWeightLight ?? -0.4),
  Regular: Number(all.NSFontWeightRegular ?? 0),
  Medium: Number(all.NSFontWeightMedium ?? 0.23),
  Semibold: Number(all.NSFontWeightSemibold ?? 0.3),
  Bold: Number(all.NSFontWeightBold ?? 0.4),
  Heavy: Number(all.NSFontWeightHeavy ?? 0.56),
  Black: Number(all.NSFontWeightBlack ?? 0.62),
} as const;

export const AutoresizingMask = pick({
  NotSizable: "NSViewNotSizable",
  MinXMargin: "NSViewMinXMargin",
  WidthSizable: "NSViewWidthSizable",
  MaxXMargin: "NSViewMaxXMargin",
  MinYMargin: "NSViewMinYMargin",
  HeightSizable: "NSViewHeightSizable",
  MaxYMargin: "NSViewMaxYMargin",
});

export const WindowCollectionBehavior = pick({
  Default: "NSWindowCollectionBehaviorDefault",
  FullScreenPrimary: "NSWindowCollectionBehaviorFullScreenPrimary",
  FullScreenAuxiliary: "NSWindowCollectionBehaviorFullScreenAuxiliary",
});

export const WindowTitleVisibility = pick({
  Visible: "NSWindowTitleVisible",
  Hidden: "NSWindowTitleHidden",
});

export const ScrollElasticity = pick({
  Automatic: "NSScrollElasticityAutomatic",
  None: "NSScrollElasticityNone",
  Allowed: "NSScrollElasticityAllowed",
});

/**
 * The outline a control draws, macOS 26 (`NSControlBorderShape`). Capsule is what sits right
 * inside a Liquid Glass capsule — a toolbar group, a floating strip.
 */
export const ControlBorderShape = pick({
  Automatic: "NSControlBorderShapeAutomatic",
  Capsule: "NSControlBorderShapeCapsule",
  RoundedRectangle: "NSControlBorderShapeRoundedRectangle",
  Circle: "NSControlBorderShapeCircle",
});

export const SegmentStyle = pick({
  Automatic: "NSSegmentStyleAutomatic",
  Rounded: "NSSegmentStyleRounded",
  RoundRect: "NSSegmentStyleRoundRect",
  TexturedSquare: "NSSegmentStyleTexturedSquare",
  SmallSquare: "NSSegmentStyleSmallSquare",
  Separated: "NSSegmentStyleSeparated",
});

export const SplitViewDividerStyle = pick({
  Thick: "NSSplitViewDividerStyleThick",
  Thin: "NSSplitViewDividerStyleThin",
  PaneSplitter: "NSSplitViewDividerStylePaneSplitter",
});

export const TextFieldBezelStyle = pick({
  Square: "NSTextFieldSquareBezel",
  Rounded: "NSTextFieldRoundedBezel",
});

export const BitmapImageFileType = pick({
  TIFF: "NSBitmapImageFileTypeTIFF",
  BMP: "NSBitmapImageFileTypeBMP",
  GIF: "NSBitmapImageFileTypeGIF",
  JPEG: "NSBitmapImageFileTypeJPEG",
  PNG: "NSBitmapImageFileTypePNG",
});

/** The full generated constant set, for anything not grouped above. */
export { C as constants };
