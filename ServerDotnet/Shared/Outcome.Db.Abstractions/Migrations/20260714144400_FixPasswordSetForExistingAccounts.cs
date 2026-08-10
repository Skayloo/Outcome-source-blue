using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Outcome.Db.Abstractions.Migrations
{
    /// <summary>
    /// AddPasswordSet created the column with defaultValue FALSE (EF cannot see the C# property
    /// initializer), so every account that already existed was labelled "has no password of its
    /// own" — and got a backup-passphrase prompt meant only for SSO accounts. Repair the data
    /// and the column default.
    ///
    /// Precise, not blanket: an account stays password-less ONLY if the audit log says it was
    /// created through SSO. Everyone else chose their password at registration.
    /// </summary>
    public partial class FixPasswordSetForExistingAccounts : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"
                ALTER TABLE users ALTER COLUMN password_set SET DEFAULT TRUE;

                UPDATE users SET password_set = TRUE
                WHERE id NOT IN (
                    SELECT target_id FROM audit_log
                    WHERE action = 'user_register' AND detail LIKE '%sso%'
                );
            ");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("ALTER TABLE users ALTER COLUMN password_set SET DEFAULT FALSE;");
        }
    }
}
