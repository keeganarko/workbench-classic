import type { JSX } from 'react'
import type { SessionProject } from '../../../shared/types'
import { ProjectMark, projectDesignStyle } from './ProjectArtwork'
import { Icon } from './Icon'

/**
 * Project IDs remain the filter keys: duplicate names and renames must never
 * combine unrelated work. Use ordinary pressed buttons so keyboard and voice
 * users can select the same named targets they see, without a custom listbox.
 */
export function ProjectFilter({ projects, value, onChange, emptyLabel = 'All projects' }: {
  projects: SessionProject[]; value: string | null; onChange: (id: string | null) => void; emptyLabel?: string
}): JSX.Element {
  return <div className="project-filter" role="group" aria-label="Filter by project">
    <span className="project-filter-label">Projects</span>
    <div className="project-filter-options">
      <button type="button" aria-pressed={value === null} onClick={() => onChange(null)}>
        <Icon name="folder" size={16} /><span>{emptyLabel}</span>
      </button>
      {projects.map((project) => <button type="button" key={project.id} className="project-design"
        style={projectDesignStyle(project.appearance)} title={project.name}
        aria-pressed={value === project.id} onClick={() => onChange(project.id)}>
        <ProjectMark name={project.name} appearance={project.appearance} /><span>{project.name}</span>
      </button>)}
    </div>
  </div>
}

/** Keep native select keyboard navigation and form validation in dialogs. */
export function ProjectSelect({ projects, value, onChange, emptyLabel = 'No project', required = false }: {
  projects: SessionProject[]; value: string; onChange: (id: string) => void; emptyLabel?: string; required?: boolean
}): JSX.Element {
  const project = projects.find((item) => item.id === value)
  return <span className="project-select">
    {project ? <ProjectMark name={project.name} appearance={project.appearance} /> : <Icon name="folder" size={18} />}
    <select aria-label="Project" required={required} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="" disabled={required}>{emptyLabel}</option>
      {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>
  </span>
}
