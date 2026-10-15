/**
 * What the agent should do next, as a field. The prose in `message` / `reason` stays the full story; this is
 * the one decision in it, so a weaker model does not have to dig it out. In the QA runs DeepSeek lost track of the next
 * step in long results and asked the wrong question, or none.
 */
export type NextStep =
  /** Tell the user the price and ask; call again with `confirm: true` only after their explicit yes. */
  | 'ask_user_to_confirm_payment'
  /** Show the verification link and how long it is open; ask the user to message back once done. */
  | 'show_link_and_wait'
  /** The user already holds this credential: show it and ask whether to keep it or replace it. */
  | 'ask_user_whether_to_replace'
  /** A payment is still settling: ask the user to message back in a few minutes, then check again. */
  | 'wait_then_check'
  /** The user already holds this credential: tell them, and do not start another. */
  | 'tell_user_already_held'
  /** Something stands in the way: tell the user every blocker, together. */
  | 'resolve_blockers'
  /** Nothing stands in the way: collect the details the credential needs. */
  | 'collect_details'
  /**
   * An AI Birthcert with nothing in the way: unless the user has already said Basic or Verified, ask which first (the
   * `choice` note), then collect the details.
   */
  | 'confirm_kind_then_collect_details'
  /** A credential was just issued: show it to the user. */
  | 'show_credential'
  /**
   * It did not go ahead: tell the user what the result's text says, and take only the next step that text names, if any
   * (it often names one, such as check_ai_birthcert_verification). Never retry a payment on your own (review R2).
   */
  | 'follow_message'
