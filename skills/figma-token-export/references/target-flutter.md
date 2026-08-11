# Target: Flutter / Dart


## Contents

- Output
- Decisions baked into the output, and why
- Wiring into a theme
- Verifying

---

## Output

```
lib/tokens/
  colors.g.dart        AppColors      — static const Color
  dimensions.g.dart    AppSpacing, AppRadius, AppBorderWidth — static const double
  typography.g.dart    AppTypography  — static const TextStyle
  shadows.g.dart       AppShadows     — static const List<BoxShadow>
  tokens.g.dart        barrel
```

```dart
abstract final class AppColors {
  const AppColors._();

  /// Figma: `text/primary/default` (#030712FF)
  static const Color textPrimaryDefault = Color(0xFF030712);
}

abstract final class AppSpacing {
  const AppSpacing._();

  /// Figma: `spacing/8`
  static const double n8 = 8.0;
}

abstract final class AppTypography {
  const AppTypography._();

  /// Figma: `body/lg/bold` — 16/22px
  static const TextStyle bodyLgBold = TextStyle(
    fontFamily: 'Google Sans',
    fontSize: 16.0,
    fontWeight: FontWeight.w700,
    height: 1.375,
  );
}

abstract final class AppShadows {
  const AppShadows._();

  /// Figma: `shadow-md`
  static const List<BoxShadow> shadowMd = [
    BoxShadow(color: Color(0x1F000000), offset: Offset(0.0, 0.0), blurRadius: 1.0, spreadRadius: 0.0),  // color/shadow/md/edge
    BoxShadow(color: Color(0x1F000000), offset: Offset(0.0, 8.0), blurRadius: 24.0, spreadRadius: -4.0),  // color/shadow/md/ambient
  ];
}
```

Two limits worth knowing before you look for the missing shadow:

- **Shadow colours are literals**, with the Figma colour token named in a
  trailing comment. `BoxShadow` needs a `Color`, and a `const` list cannot
  resolve a cross-class reference once `groupColorsByNamespace` moves that
  colour elsewhere. Theming shadows means picking a different class, the same
  way colours do.
- **Inset shadows are skipped**, named in a `// SKIPPED` comment at the top of
  the file. Flutter's `BoxShadow` has no inset, and dropping the layer silently
  would ship a shadow that does not match the design.

A dimension namespace that collides with one of these class names takes a
`Scale` suffix — `typography/font-size/*` becomes `AppTypographyScale`, leaving
`AppTypography` to the text styles.

Options in `tokens.config.json`:

| key | effect |
|---|---|
| `prefix` | class prefix (`"App"` → `AppColors`) |
| `groupColorsByNamespace` | `true` splits colours into `AppTextColors`, `AppSurfaceColors`, … by first path segment |
| `fontFamily` | override the family from Figma (use when the bundled font is registered under a different name) |
| `fontPackage` | emits `package:` on every `TextStyle` — required when fonts ship from a package, not the app |

## Decisions baked into the output, and why

- **`abstract final class` with a private constructor**, not an `enum`, not a
  `class` with static members. It cannot be instantiated, extended, or
  implemented, so the token holder can never become a place someone adds logic.
- **`static const`, never `static final`.** Const values are usable inside
  const constructors and const widget subtrees, which is where Flutter's
  rebuild savings actually come from. One `final` in the chain forfeits that
  for every widget downstream.
- **`height` is a multiplier.** Figma reports line height in pixels (22px on a
  16px font); Flutter's `height` is a ratio (1.375). The generator divides.
  Copying the px value straight in produces enormous line spacing — this is the
  single most common hand-porting bug.
- **Dimensions split per namespace, colours do not (by default).** `spacing/8`
  and `radius/8` must not collide, and `AppSpacing.n8` reads better than
  `AppDimensions.spacing8`. Colours stay in one class because semantic colour
  names are already fully qualified (`textPrimaryDefault`).
- **Numeric leaves get a legal identifier.** `spacing/8` → `n8` (bare `8` is
  not a Dart identifier), `body/lg/2xl` → `bodyLg_2xl`.
- **Every field carries a `/// Figma:` doc comment** with the original token
  name. That comment is how someone reading a widget finds the token in Figma,
  and how you grep the codebase when design renames something.

## Wiring into a theme

Generated files are values, not a theme — deliberately. A Figma rename should
never break hand-written theme logic. Put the wiring in the app:

```dart
// lib/theme/app_theme.dart — hand-written, not generated
@immutable
class AppSemanticColors extends ThemeExtension<AppSemanticColors> {
  const AppSemanticColors({required this.textPrimary, required this.surface});

  final Color textPrimary;
  final Color surface;

  static const light = AppSemanticColors(
    textPrimary: AppColors.textPrimaryDefault,
    surface: AppColors.surfaceMainPrimary,
  );

  @override
  AppSemanticColors copyWith({Color? textPrimary, Color? surface}) => ...;

  @override
  AppSemanticColors lerp(AppSemanticColors? other, double t) => ...;
}
```

Two rules keep this stable:

1. **The ThemeExtension holds the app's semantic names, not Figma's.** If
   design renames `text/primary/default`, you fix one line here instead of
   every widget.
2. **Widgets read the extension, not `AppColors`.** Reaching straight for
   `AppColors` in a widget hardcodes the light-mode value and is invisible
   until someone tries dark mode.

For dark mode, extract a second `tokens.dark.json` (see
`references/tokens-schema.md`) and build a second `AppSemanticColors` const.

## Verifying

`dart analyze` on the generated directory should be clean before you commit.
The generators were validated at 511 colours / 37 dimensions / 33 text styles
from a production file: no issues found.

Do not add generated files to `.gitignore`. Commit them — the diff is the
evidence that a design change reached code, and it is what CI's
`generate.mjs --check` compares against.
