import { z } from "zod";

/**
 * Feedback from users (ADR-0033, capability `feedback`): a problem, an idea or a question, sent from the desktop app,
 * the web client or the website's support page. No sign-in is needed; a valid bearer credential, when one comes with
 * it, ties the feedback to that account. Only what the person typed and, if they agree, a short description of the
 * client goes out: never page text, titles or file names. The objects are strict, so nothing else can ride along.
 */

export const FEEDBACK_KINDS = ["problem", "idea", "question"] as const;
export const FeedbackKindSchema = z.enum(FEEDBACK_KINDS);
export type FeedbackKind = z.infer<typeof FeedbackKindSchema>;

export const FEEDBACK_MESSAGE_MAX = 5000;
export const FEEDBACK_EMAIL_MAX = 254;
export const FEEDBACK_CLIENTS = ["desktop", "web", "site"] as const;

/** A short label: printable characters only, no control characters, at most `max` characters. */
const shortText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    // No `u` flag: the pattern must mean the same in JSON Schema.
    .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/, "Expected printable characters");

/** What the client says about itself when the person leaves "Include the app version and system" on. */
export const FeedbackContextSchema = z.strictObject({
  client: z.enum(FEEDBACK_CLIENTS),
  /** The app version, for example `0.4.0`. */
  version: z
    .string()
    .max(40)
    .regex(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/, "Expected a version like 0.4.0")
    .optional(),
  /** The operating system, for example `macOS 15.1` or `Windows`. */
  os: shortText(60).optional(),
  /** The interface language, a BCP 47 tag such as `en` or `th`. */
  language: z
    .string()
    .max(35)
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Expected a language tag like en or th")
    .optional(),
});
export type FeedbackContext = z.infer<typeof FeedbackContextSchema>;

/** Body of `sendFeedback`. */
export const FeedbackRequestSchema = z.strictObject({
  kind: FeedbackKindSchema,
  message: z
    .string()
    .min(1)
    .max(FEEDBACK_MESSAGE_MAX)
    .refine((m) => m.trim().length > 0, "Expected a message"),
  /** Where to answer, if the person wants an answer. */
  email: z.email().max(FEEDBACK_EMAIL_MAX).optional(),
  context: FeedbackContextSchema.optional(),
  /** Honeypot of the website form: people never see it, so a value means a script filled it in. Leave it out. */
  website: z.string().max(500).optional(),
});
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;
