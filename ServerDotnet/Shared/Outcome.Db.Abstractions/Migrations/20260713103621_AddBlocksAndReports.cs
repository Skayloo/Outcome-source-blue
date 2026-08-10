using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Outcome.Db.Abstractions.Migrations
{
    /// <inheritdoc />
    public partial class AddBlocksAndReports : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "message_reports",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    reporter_id = table.Column<long>(type: "bigint", nullable: false),
                    message_id = table.Column<long>(type: "bigint", nullable: false),
                    author_id = table.Column<long>(type: "bigint", nullable: false),
                    content = table.Column<string>(type: "text", nullable: false),
                    reason = table.Column<string>(type: "text", nullable: false),
                    status = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_message_reports", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "user_blocks",
                columns: table => new
                {
                    blocker_id = table.Column<long>(type: "bigint", nullable: false),
                    blocked_id = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_user_blocks", x => new { x.blocker_id, x.blocked_id });
                });

            migrationBuilder.CreateIndex(
                name: "IX_message_reports_status",
                table: "message_reports",
                column: "status");

            migrationBuilder.CreateIndex(
                name: "IX_user_blocks_blocked_id",
                table: "user_blocks",
                column: "blocked_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "message_reports");

            migrationBuilder.DropTable(
                name: "user_blocks");
        }
    }
}
