const ADMIN_EMAILS = (process.env.NEXT_PUBLIC_ADMIN_EMAILS || "").split(",").map(e => e.trim().toLowerCase());

export function isAdmin(email: string | undefined | null): boolean {
    if (!email) return false;
    return ADMIN_EMAILS.includes(email.toLowerCase());
}

export function canEditPersonality(
    userEmail: string | undefined | null,
    userId: string,
    personality: { creator_id: string | null }
): boolean {
    // Admin can edit all personalities
    if (isAdmin(userEmail)) return true;

    // User can only edit their own personalities
    if (personality.creator_id && personality.creator_id === userId) return true;

    return false;
}
