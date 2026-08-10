using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Outcome.Db.Abstractions.Migrations
{
    /// <inheritdoc />
    public partial class AddVoiceAttachmentFields : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "duration_ms",
                table: "attachments",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "waveform",
                table: "attachments",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "duration_ms",
                table: "attachments");

            migrationBuilder.DropColumn(
                name: "waveform",
                table: "attachments");
        }
    }
}
