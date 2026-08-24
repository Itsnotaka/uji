import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import * as stylex from "@stylexjs/stylex";
import { IconCrossSmall } from "central-icons";
import type * as React from "react";

import { Button } from "@uji-ai/ui/components/ui/button";
import { IconBox } from "@uji-ai/ui/components/ui/icon-box";
import { mergeStyleProps, type XStyle } from "@uji-ai/ui/style";
import {
  borderVars,
  colorVars,
  controlVars,
  elevationVars,
  fontVars,
  motionVars,
  overlayVars,
  radiusVars,
  spaceVars,
} from "@uji-ai/ui/tokens.stylex";

const styles = stylex.create({
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: overlayVars["--uji-layer-dialog"],
    backgroundColor: colorVars["--uji-color-scrim"],
    opacity: { default: 1, "[data-starting-style]": 0, "[data-ending-style]": 0 },
    transitionProperty: "opacity",
    transitionDuration: {
      default: motionVars["--uji-motion-normal"],
      "@media (prefers-reduced-motion: reduce)": "0s",
    },
    transitionTimingFunction: motionVars["--uji-motion-ease-out"],
  },
  popup: {
    position: "fixed",
    top: "50%",
    left: "50%",
    zIndex: overlayVars["--uji-layer-dialog"],
    display: "grid",
    boxSizing: "border-box",
    width: overlayVars["--uji-dialog-width"],
    maxWidth: overlayVars["--uji-dialog-max-width"],
    maxHeight: overlayVars["--uji-dialog-max-height"],
    gap: spaceVars["--uji-space-4"],
    overflowY: "auto",
    padding: spaceVars["--uji-space-4"],
    transform: "translate(-50%, -50%)",
    transformOrigin: "center",
    borderWidth: borderVars["--uji-border-control-width"],
    borderStyle: "solid",
    borderColor: colorVars["--uji-color-border"],
    borderRadius: radiusVars["--uji-radius-dialog"],
    backgroundColor: colorVars["--uji-color-popover"],
    boxShadow: elevationVars["--uji-elevation-dialog"],
    color: colorVars["--uji-color-popover-foreground"],
    fontFamily: fontVars["--uji-font-family-ui"],
    fontSize: fontVars["--uji-font-size-body"],
    lineHeight: fontVars["--uji-leading-body"],
    outline: "none",
    opacity: { default: 1, "[data-starting-style]": 0, "[data-ending-style]": 0 },
    scale: { default: 1, "[data-starting-style]": 0.98, "[data-ending-style]": 0.98 },
    transitionProperty: "opacity, scale",
    transitionDuration: {
      default: motionVars["--uji-motion-normal"],
      "@media (prefers-reduced-motion: reduce)": "0s",
    },
    transitionTimingFunction: motionVars["--uji-motion-ease-out"],
  },
  close: {
    position: "absolute",
    top: spaceVars["--uji-space-2"],
    right: spaceVars["--uji-space-2"],
  },
  header: {
    display: "flex",
    flexDirection: "column",
    // Clears the absolutely positioned close button.
    paddingInlineEnd: controlVars["--uji-control-height-sm"],
    gap: spaceVars["--uji-space-1"],
  },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: spaceVars["--uji-space-2"],
  },
  title: {
    margin: 0,
    color: colorVars["--uji-color-popover-foreground"],
    fontSize: fontVars["--uji-font-size-title"],
    fontWeight: fontVars["--uji-font-weight-medium"],
    lineHeight: fontVars["--uji-leading-title"],
  },
  description: {
    margin: 0,
    color: colorVars["--uji-color-muted-foreground"],
    fontSize: fontVars["--uji-font-size-body"],
    lineHeight: fontVars["--uji-leading-body"],
  },
});

// Shared with alert-dialog.tsx, which renders the same popup surface.
export const dialogStyles = styles;

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;
export const createDialogHandle = DialogPrimitive.createHandle;
export type DialogHandle<Payload> = DialogPrimitive.Handle<Payload>;

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
