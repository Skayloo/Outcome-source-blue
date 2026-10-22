using System.Xml.Linq;
using Microsoft.AspNetCore.DataProtection.Repositories;

namespace Outcome.Api.Security;

/// <summary>Data Protection's key ring, held in this process only (see Program.cs).</summary>
public sealed class InMemoryXmlRepository : IXmlRepository
{
    private readonly List<XElement> _elements = [];

    public IReadOnlyCollection<XElement> GetAllElements()
    {
        lock (_elements) return _elements.ToList();
    }

    public void StoreElement(XElement element, string friendlyName)
    {
        lock (_elements) _elements.Add(element);
    }
}
