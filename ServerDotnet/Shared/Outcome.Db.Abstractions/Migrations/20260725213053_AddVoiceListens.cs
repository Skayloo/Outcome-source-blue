using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Outcome.Db.Abstractions.Migrations
{
    /// <inheritdoc />
    public partial class AddVoiceListens : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "voice_listens",
                columns: table => new
                {
                    user_id = table.Column<long>(type: "bigint", nullable: false),
                    attachment_id = table.Column<string>(type: "text", nullable: false),
                    listened_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_voice_listens", x => new { x.user_id, x.attachment_id });
                    table.ForeignKey(
                        name: "FK_voice_listens_attachments_attachment_id",
                        column: x => x.attachment_id,
                        principalTable: "attachments",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_voice_listens_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_voice_listens_attachment_id",
                table: "voice_listens",
                column: "attachment_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "voice_listens");
        }
    }
}
