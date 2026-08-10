using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Outcome.Db.Abstractions.Migrations
{
    /// <inheritdoc />
    public partial class AddChannelMutes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "channel_mutes",
                columns: table => new
                {
                    user_id = table.Column<long>(type: "bigint", nullable: false),
                    channel_id = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_channel_mutes", x => new { x.user_id, x.channel_id });
                    table.ForeignKey(
                        name: "FK_channel_mutes_channels_channel_id",
                        column: x => x.channel_id,
                        principalTable: "channels",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_channel_mutes_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_channel_mutes_channel_id",
                table: "channel_mutes",
                column: "channel_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "channel_mutes");
        }
    }
}
