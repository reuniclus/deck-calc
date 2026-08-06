/**
 * Numeric input that can be emptied and retyped without fighting the user.
 *
 * Every numeric field in the app previously dispatched `parseNumOr0` on each keystroke,
 * so emptying one sent 0, the reducer clamped it to its minimum, and the field
 * redisplayed that minimum -- turning "backspace then 99" into "199". Clamping on
 * COMMIT is right; clamping on every keystroke is what broke typing.
 *
 * This wraps `useNumberField` so the fix applies by construction wherever it is used,
 * rather than each call site having to remember. `onCommit` receives only parseable
 * values, and the reducer stays free to clamp them however it likes.
 */
import type { InputHTMLAttributes } from 'react';
import { useNumberField } from './numberInput';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: number;
  onCommit: (n: number) => void;
};

export function NumberInput({ value, onCommit, ...rest }: Props) {
  const field = useNumberField(value, onCommit);
  return (
    <input
      {...rest}
      value={field.value}
      onChange={(e) => field.onChange(e.target.value)}
      onBlur={(e) => { field.onBlur(); rest.onBlur?.(e); }}
    />
  );
}
