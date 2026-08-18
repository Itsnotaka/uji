import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import * as stylex from "@stylexjs/stylex";
import { IconCrossSmall } from "central-icons";
import type * as React from "react";

import { Button } from "@june/ui/components/ui/button";
import { IconBox } from "@june/ui/components/ui/icon-box";
import { mergeStyleProps, type XStyle } from "@june/ui/style";
import {
  borderVars,
  colorVars,
  elevationVars,
  fontVars,
  motionVars,
  overlayVars,
  radiusVars,
  spaceVars,
} from "@june/ui/tokens.stylex";

const styles = stylex.create({
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: overlayVars["--june-layer-dialog"],
    backgroundColor: colorVars["--june-color-scrim"],
    opacity: { default: 1, "[data-starting-style]": 0, "[data-ending-style]": 0 },
    transitionProperty: "opacity",
    transitionDuration: {
      default: motionVars["--june-motion-fast"],
      "@media (prefers-reduced-motion: reduce)": "0s",
    },
    transitionTimingFunction: motionVars["--june-motion-ease-out"],
  },
  popup: {
    position: "fixed",
    top: "50%",
    left: "50%",
    zIndex: overlayVars["--june-layer-dialog"],
    display: "grid",
    boxSizing: "border-box",
    width: overlayVars["--june-dialog-width"],
    maxWidth: overlayVars["--june-dialog-max-width"],
    maxHeight: overlayVars["--june-dialog-max-height"],
    gap: spaceVars["--june-space-4"],
    overflowY: "auto",
    padding: spaceVars["--june-space-4"],
    transform: "translate(-50%, -50%)",
    transformOrigin: "center",
    borderWidth: borderVars["--june-border-hairline-width"],
    borderStyle: "solid",
    borderColor: colorVars["--june-color-border"],
    borderRadius: radiusVars["--june-radius-dialog"],
    backgroundColor: colorVars["--june-color-popover"],
    boxShadow: elevationVars["--june-elevation-dialog"],
    color: colorVars["--june-color-popover-foreground"],
    fontFamily: fontVars["--june-font-family-ui"],
    fontSize: fontVars["--june-font-size-body"],
    lineHeight: fontVars["--june-leading-body"],
    outline: "none",
    opacity: { default: 1, "[data-starting-style]": 0, "[data-ending-style]": 0 },
    scale: { default: 1, "[data-starting-style]": 0.98, "[data-ending-style]": 0.98 },
    transitionProperty: "opacity, scale",
    transitionDuration: {
      default: motionVars["--june-motion-fast"],
      "@media (prefers-reduced-motion: reduce)": "0s",
    },
    transitionTimingFunction: motionVars["--june-motion-ease-out"],
  },
  close: {
    position: "absolute",
    top: spaceVars["--june-space-2"],
    right: spaceVars["--june-space-2"],
  },
  header: { display: "flex", flexDirection: "column", gap: spaceVars["--june-space-2"] },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: spaceVars["--june-space-2"],
  },
  title: {
    margin: 0,
    color: colorVars["--june-color-popover-foreground"],
    fontSize: fontVars["--june-font-size-title"],
    fontWeight: fontVars["--june-font-weight-medium"],
    lineHeight: fontVars["--june-leading-title"],
  },
  description: {
    margin: 0,
    color: colorVars["--june-color-muted-foreground"],
    fontSize: fontVars["--june-font-size-body"],
    lineHeight: fontVars["--june-leading-body"],
  },
});

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

type StyledProps<Props> = Omit<Props, "className" | "style"> & {
  className?: string;
  style?: React.CSSProperties;
  xstyle?: XStyle;
};

export type DialogOverlayProps = StyledProps<DialogPrimitive.Backdrop.Props>;

export function DialogOverlay({ className, style, xstyle, ...props }: DialogOverlayProps) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      {...mergeStyleProps(stylex.props(styles.overlay, xstyle), className, style)}
      {...props}
    />
  );
}

export interface DialogContentProps extends StyledProps<DialogPrimitive.Popup.Props> {
  motionDuration?: React.CSSProperties["transitionDuration"];
  overlayXstyle?: XStyle;
  showCloseButton?: boolean;
}

export function DialogContent({
  children,
  className,
  motionDuration,
  overlayXstyle,
  showCloseButton = true,
  style,
  xstyle,
  ...props
}: DialogContentProps) {
  return (
    <DialogPortal>
      <DialogOverlay
        style={motionDuration === undefined ? undefined : { transitionDuration: motionDuration }}
        xstyle={overlayXstyle}
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        {...mergeStyleProps(
          stylex.props(styles.popup, xstyle),
          className,
          motionDuration === undefined ? style : { ...style, transitionDuration: motionDuration },
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            aria-label="Close"
            render={<Button size="icon-sm" variant="ghost" xstyle={styles.close} />}
          >
            <IconBox glyphSize={12}>
              <IconCrossSmall />
            </IconBox>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

export type DialogHeaderProps = StyledProps<React.ComponentProps<"div">>;

export function DialogHeader({ className, style, xstyle, ...props }: DialogHeaderProps) {
  return (
    <div
      data-slot="dialog-header"
      {...mergeStyleProps(stylex.props(styles.header, xstyle), className, style)}
      {...props}
    />
  );
}

export interface DialogFooterProps extends StyledProps<React.ComponentProps<"div">> {
  showCloseButton?: boolean;
}

export function DialogFooter({
  children,
  className,
  showCloseButton = false,
  style,
  xstyle,
  ...props
}: DialogFooterProps) {
  return (
    <div
      data-slot="dialog-footer"
      {...mergeStyleProps(stylex.props(styles.footer, xstyle), className, style)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>Close</DialogPrimitive.Close>
      )}
    </div>
  );
}

export type DialogTitleProps = StyledProps<DialogPrimitive.Title.Props>;

export function DialogTitle({ className, style, xstyle, ...props }: DialogTitleProps) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      {...mergeStyleProps(stylex.props(styles.title, xstyle), className, style)}
      {...props}
    />
  );
}

export type DialogDescriptionProps = StyledProps<DialogPrimitive.Description.Props>;

export function DialogDescription({ className, style, xstyle, ...props }: DialogDescriptionProps) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      {...mergeStyleProps(stylex.props(styles.description, xstyle), className, style)}
      {...props}
    />
  );
}
