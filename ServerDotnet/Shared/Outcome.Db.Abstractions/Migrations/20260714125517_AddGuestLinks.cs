using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Outcome.Db.Abstractions.Migrations
{
    /// <inheritdoc />
    public partial class AddGuestLinks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "guest_links",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    code = table.Column<string>(type: "text", nullable: false),
                    channel_id = table.Column<long>(type: "bigint", nullable: false),
                    created_by = table.Column<long>(type: "bigint", nullable: false),
                    revoked = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_guest_links", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_guest_links_channel_id",
                table: "guest_links",
                column: "channel_id");

            migrationBuilder.CreateIndex(
                name: "IX_guest_links_code",
                table: "guest_links",
                column: "code",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "guest_links");
        }
    }
}
